import Anthropic from "@anthropic-ai/sdk";
import {
  REVIEW_JSON_SCHEMA,
  reviewResponseSchema,
} from "../schemas/review.schema.js";
import {
  ReviewModelError,
  abortedError,
  httpStatusError,
  malformedError,
  missingKeyError,
  normalizeThrown,
  refusedError,
  truncatedError,
} from "./errors.js";
import type { ModelRequest, ModelResult, ReviewModel } from "./types.js";

type JsonObject = Record<string, unknown>;

/**
 * Anthropic structured outputs accept a subset of JSON Schema: no array size
 * bounds and no `type` unions. This only rewrites the dialect; the shared zod
 * schema still enforces every bound on the returned object.
 */
export function toAnthropicOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toAnthropicOutputSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as JsonObject;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "minItems" || key === "maxItems") continue;
    result[key] = toAnthropicOutputSchema(value);
  }
  if (Array.isArray(source.type) && source.type.length > 1) {
    const { type: _type, ...rest } = result;
    return {
      ...rest,
      anyOf: (source.type as string[]).map((type) => ({ type })),
    };
  }
  return result;
}

const ANTHROPIC_REVIEW_SCHEMA = toAnthropicOutputSchema(
  REVIEW_JSON_SCHEMA,
) as Record<string, unknown>;

export type AnthropicReviewModelOptions = {
  apiKey?: string;
  /** Defaults to the SDK default (https://api.anthropic.com). */
  baseURL?: string;
  fetch?: typeof fetch;
};

export class AnthropicReviewModel implements ReviewModel {
  readonly provider = "anthropic";
  private readonly apiKey: string | undefined;
  private readonly client: Anthropic;

  constructor(options: AnthropicReviewModelOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    // maxRetries: 0 — retries belong to executeModel, so every HTTP attempt is
    // visible to the shared ExternalRequestBudget. The SDK must never retry
    // behind its back. Construction makes no network call.
    this.client = new Anthropic({
      apiKey: this.apiKey ?? null,
      baseURL: options.baseURL,
      fetch: options.fetch,
      maxRetries: 0,
    });
  }

  /** Endpoint origin and path only: no credentials, query, or API key. */
  get identity(): string {
    try {
      const url = new URL(this.client.baseURL);
      return `anthropic-messages/json-schema-v1@${url.origin}${url.pathname}`;
    } catch {
      return "anthropic-messages/json-schema-v1@invalid-endpoint";
    }
  }

  async review(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    if (!this.apiKey) throw missingKeyError(this.provider, "ANTHROPIC_API_KEY");
    // An already-cancelled call must never reach the wire.
    if (signal.aborted) throw abortedError(this.provider, signal);
    let message: Anthropic.Message;
    try {
      // No sampling parameters and no forced tool_choice: current models
      // reject both. The schema constraint comes from structured outputs.
      message = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: {
            format: { type: "json_schema", schema: ANTHROPIC_REVIEW_SCHEMA },
          },
        },
        { signal },
      );
    } catch (error) {
      throw this.classify(error, signal);
    }
    return this.normalize(message);
  }

  private normalize(message: Anthropic.Message): ModelResult {
    if (message.stop_reason === "refusal")
      throw refusedError(this.provider, "Anthropic");
    // Reasoning counts toward the output limit, so this can occur even for a
    // short answer; a cut-off object is never partially accepted.
    if (message.stop_reason === "max_tokens")
      throw truncatedError(this.provider, "Anthropic");
    const content = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    if (!content)
      throw malformedError(
        this.provider,
        "Anthropic response did not include structured content",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw malformedError(this.provider, "Anthropic returned malformed JSON");
    }
    const validated = reviewResponseSchema.safeParse(parsed);
    if (!validated.success)
      throw malformedError(
        this.provider,
        // Paths only: zod messages can echo returned values.
        `Anthropic output failed schema validation (${validated.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "(root)")
          .join(", ")})`,
      );
    const usage = message.usage;
    const reported =
      typeof usage?.input_tokens === "number" &&
      typeof usage.output_tokens === "number";
    return {
      response: validated.data,
      usage: reported
        ? {
            // input_tokens excludes cached tokens; the domain figure is the
            // whole prompt, as with OpenAI's prompt_tokens.
            inputTokens:
              usage.input_tokens +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0),
            outputTokens: usage.output_tokens,
            actual: true,
          }
        : { inputTokens: 0, outputTokens: 0, actual: false },
    };
  }

  /** The only place Anthropic SDK error classes are inspected. */
  private classify(error: unknown, signal: AbortSignal): ReviewModelError {
    if (error instanceof ReviewModelError) return error;
    if (signal.aborted) return abortedError(this.provider, signal);
    if (error instanceof Anthropic.APIUserAbortError)
      return new ReviewModelError({
        kind: "aborted",
        provider: this.provider,
        message: "Anthropic request aborted",
      });
    if (error instanceof Anthropic.APIConnectionTimeoutError)
      return new ReviewModelError({
        kind: "timeout",
        provider: this.provider,
        message: "Anthropic request timed out",
      });
    if (error instanceof Anthropic.APIConnectionError)
      return new ReviewModelError({
        kind: "network",
        provider: this.provider,
        message: "Anthropic connection error",
      });
    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      const body = (error.error as { error?: { type?: unknown } } | undefined)
        ?.error;
      return httpStatusError({
        provider: this.provider,
        label: "Anthropic",
        status: error.status,
        code: typeof body?.type === "string" ? body.type : undefined,
        headers: error.headers as Headers | undefined,
      });
    }
    return normalizeThrown(error, {
      provider: this.provider,
      label: "Anthropic",
      signal,
    });
  }
}

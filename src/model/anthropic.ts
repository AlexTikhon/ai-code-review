import Anthropic from "@anthropic-ai/sdk";
import {
  REVIEW_JSON_SCHEMA,
  reviewResponseSchema,
} from "../schemas/review.schema.js";
import {
  ModelError,
  type ModelRequest,
  type ModelResult,
  type ReviewModel,
} from "./types.js";

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

function retryAfterMs(
  error: InstanceType<typeof Anthropic.APIError>,
): number | undefined {
  const headers = error.headers as Headers | undefined;
  const ms = Number(headers?.get?.("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.get?.("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

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
    if (!this.apiKey) throw new ModelError("Missing ANTHROPIC_API_KEY", false);
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
      throw this.classify(error);
    }
    return this.normalize(message);
  }

  private normalize(message: Anthropic.Message): ModelResult {
    if (message.stop_reason === "refusal")
      throw new ModelError("Anthropic declined to review this content", false);
    if (message.stop_reason === "max_tokens")
      throw new ModelError(
        "Anthropic output was cut off at the output token limit (reasoning counts toward it); raise AI_REVIEW_MAX_OUTPUT_TOKENS",
        false,
      );
    const content = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    if (!content)
      throw new ModelError(
        "Anthropic response did not include structured content",
        true,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ModelError("Anthropic returned malformed JSON", true);
    }
    const validated = reviewResponseSchema.safeParse(parsed);
    if (!validated.success)
      throw new ModelError(
        `Anthropic output failed schema validation: ${validated.error.message}`,
        true,
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

  private classify(error: unknown): ModelError {
    if (error instanceof ModelError) return error;
    if (error instanceof Anthropic.APIUserAbortError)
      return new ModelError("Anthropic request aborted", false);
    if (error instanceof Anthropic.APIConnectionError)
      return new ModelError(this.safe(`Anthropic connection error`), true);
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      const retryable =
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500);
      return new ModelError(
        this.safe(`Anthropic error ${status}: ${error.message}`),
        retryable,
        retryable ? retryAfterMs(error) : undefined,
      );
    }
    return new ModelError(
      this.safe(
        `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      false,
    );
  }

  /** Error text may echo server output; never let the key or a long body out. */
  private safe(text: string): string {
    const redacted = this.apiKey ? text.split(this.apiKey).join("[key]") : text;
    return redacted.slice(0, 500);
  }
}

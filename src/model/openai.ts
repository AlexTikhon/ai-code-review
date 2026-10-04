import {
  reviewResponseSchema,
  OPENAI_REVIEW_JSON_SCHEMA,
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

type OpenAIErrorBody = {
  error?: { message?: unknown; code?: unknown; type?: unknown };
};

export class OpenAIReviewModel implements ReviewModel {
  readonly provider = "openai";
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly endpoint = "https://api.openai.com/v1/chat/completions",
    /** Test seam; defaults to the global fetch at call time. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** Endpoint origin and path only: no credentials, query, or API key. */
  get identity(): string {
    try {
      const url = new URL(this.endpoint);
      return `openai-chat-completions/json-schema-v1@${url.origin}${url.pathname}`;
    } catch {
      return "openai-chat-completions/json-schema-v1@invalid-endpoint";
    }
  }

  async review(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    if (!this.apiKey) throw missingKeyError(this.provider, "OPENAI_API_KEY");
    // An already-cancelled call must never reach the wire.
    if (signal.aborted) throw abortedError(this.provider, signal);
    try {
      return await this.send(request, signal);
    } catch (error) {
      throw this.normalize(error, signal);
    }
  }

  private async send(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const response = await (this.fetchImpl ?? fetch)(this.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        max_tokens: request.maxOutputTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: OPENAI_REVIEW_JSON_SCHEMA,
        },
      }),
    });
    if (!response.ok) throw await this.httpError(response);
    let payload: {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null; refusal?: string | null };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      payload = await response.json();
    } catch {
      throw malformedError(this.provider, "OpenAI returned a non-JSON body");
    }
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "length")
      throw truncatedError(this.provider, "OpenAI");
    if (choice?.finish_reason === "content_filter" || choice?.message?.refusal)
      throw refusedError(this.provider, "OpenAI");
    const content = choice?.message?.content;
    if (!content)
      throw malformedError(
        this.provider,
        "OpenAI response did not include structured content",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw malformedError(this.provider, "OpenAI returned malformed JSON");
    }
    const validated = reviewResponseSchema.safeParse(parsed);
    if (!validated.success)
      throw malformedError(
        this.provider,
        // Paths and issue codes only: zod messages can echo returned values.
        `OpenAI output failed schema validation (${validated.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "(root)")
          .join(", ")})`,
      );
    return {
      response: validated.data,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        actual: payload.usage?.prompt_tokens !== undefined,
      },
    };
  }

  private async httpError(response: Response): Promise<ReviewModelError> {
    let detail: string | undefined;
    let code: string | undefined;
    try {
      const body = JSON.parse(await response.text()) as OpenAIErrorBody;
      if (typeof body.error?.message === "string") detail = body.error.message;
      const raw = body.error?.code ?? body.error?.type;
      if (typeof raw === "string") code = raw;
    } catch {
      // A non-JSON error body is never echoed.
    }
    return httpStatusError({
      provider: this.provider,
      label: "OpenAI",
      status: response.status,
      detail,
      code,
      headers: response.headers,
      secrets: [this.apiKey],
    });
  }

  private normalize(error: unknown, signal: AbortSignal): ReviewModelError {
    return normalizeThrown(error, {
      provider: this.provider,
      label: "OpenAI",
      signal,
      secrets: [this.apiKey],
    });
  }
}

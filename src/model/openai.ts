import {
  reviewResponseSchema,
  OPENAI_REVIEW_JSON_SCHEMA,
} from "../schemas/review.schema.js";
import {
  ModelError,
  type ModelRequest,
  type ModelResult,
  type ReviewModel,
} from "./types.js";
export class OpenAIReviewModel implements ReviewModel {
  readonly provider = "openai";
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly endpoint = "https://api.openai.com/v1/chat/completions",
  ) {}
  async review(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    if (!this.apiKey) throw new ModelError("Missing OPENAI_API_KEY", false);
    const response = await fetch(this.endpoint, {
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
    if (!response.ok) {
      const text = await response.text();
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500;
      throw new ModelError(
        `OpenAI error ${response.status}: ${text.slice(0, 500)}`,
        retryable,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content)
      throw new ModelError(
        "OpenAI response did not include structured content",
        true,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ModelError("OpenAI returned malformed JSON", true);
    }
    const validated = reviewResponseSchema.safeParse(parsed);
    if (!validated.success)
      throw new ModelError(
        `OpenAI output failed schema validation: ${validated.error.message}`,
        true,
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
}

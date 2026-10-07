import { estimateTokens } from "../review/patch.js";
import { REVIEW_JSON_SCHEMA } from "../schemas/review.schema.js";

/**
 * Provider-neutral input-size estimate, derived only from the shared prompt
 * (system + user text) and the shared response schema. It is a deterministic,
 * conservative budget figure: it makes no claim to match any provider's
 * tokenizer, and it is never reported as usage. Actual token counts come from
 * the provider's own response (ModelUsage).
 */

/** Every provider is sent the response schema in some dialect; count it once. */
export const RESPONSE_SCHEMA_TOKENS = estimateTokens(
  JSON.stringify(REVIEW_JSON_SCHEMA),
);

/**
 * Allowance for message roles, wrapper keys and delimiters that any chat API
 * adds around the text. Deliberately above what the known providers add.
 */
export const MESSAGE_FRAMING_TOKENS = 200;

/** Fixed part of every request, independent of the diff and context. */
export const REQUEST_OVERHEAD_TOKENS =
  RESPONSE_SCHEMA_TOKENS + MESSAGE_FRAMING_TOKENS;

/**
 * Smallest allowance a request must leave beyond its fixed text for any diff
 * content to be worth sending; below it the configuration is rejected early.
 */
export const MIN_DIFF_HEADROOM_TOKENS = 200;

export function estimatePromptTokens(prompt: {
  system: string;
  user: string;
}): number {
  return (
    estimateTokens(prompt.system) +
    estimateTokens(prompt.user) +
    REQUEST_OVERHEAD_TOKENS
  );
}

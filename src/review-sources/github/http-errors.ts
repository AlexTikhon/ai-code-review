import { redactSensitiveText } from "../../privacy/policy.js";
import { SourceError } from "../errors.js";

/** GitHub asks secondary-rate-limited clients to wait at least a minute. */
const SECONDARY_LIMIT_WAIT_MS = 60_000;
const MAX_DETAIL_CHARACTERS = 160;

/** `Retry-After` is delay-seconds or an HTTP date; anything else is ignored. */
export function parseRetryAfterMs(
  value: string | null,
  now: number,
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP dates start with a weekday name; this keeps "-4" and the like out.
  const date = /^[A-Za-z]/.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function resetDelayMs(value: string | null, now: number): number | undefined {
  const seconds = Number(value);
  return value && Number.isFinite(seconds) && seconds > 0
    ? Math.max(0, seconds * 1000 - now)
    : undefined;
}

/** GitHub's own short `message`, bounded and scrubbed; never the whole body. */
export function documentedMessage(text: string): string | undefined {
  try {
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    if (typeof message !== "string") return undefined;
    const cleaned = redactSensitiveText(message)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_DETAIL_CHARACTERS);
    return cleaned || undefined;
  } catch {
    return undefined;
  }
}

export type GithubResponseFacts = {
  status: number;
  headers: Pick<Headers, "get">;
  /** The (bounded) response text, used only to find GitHub's documented message. */
  bodyText: string;
  /** Human label of the operation, e.g. "pull request files". */
  label: string;
  /** Wall-clock milliseconds, for the rate-limit reset header. */
  now: number;
};

/**
 * Translate a non-2xx GitHub response into a SourceError. All GitHub-specific
 * status and header interpretation lives here. A 403 is rate limiting only when
 * GitHub says so (exhausted quota, Retry-After, or its documented wording);
 * otherwise it is a permission failure and is never retried.
 */
export function classifyGithubResponse(
  facts: GithubResponseFacts,
): SourceError {
  const { status, headers, label } = facts;
  const documented = documentedMessage(facts.bodyText);
  const detail = documented && status < 500 ? ` (GitHub: "${documented}")` : "";
  const prefix = `GitHub ${label} request failed`;
  const base = { source: "github", statusCode: status } as const;

  const exhausted = headers.get("x-ratelimit-remaining") === "0";
  const retryAfter = parseRetryAfterMs(headers.get("retry-after"), facts.now);
  const mentionsLimit = documented
    ? /rate limit|abuse/i.test(documented)
    : false;
  if (
    status === 429 ||
    (status === 403 && (exhausted || retryAfter !== undefined || mentionsLimit))
  ) {
    const retryAfterMs =
      retryAfter ??
      (exhausted
        ? resetDelayMs(headers.get("x-ratelimit-reset"), facts.now)
        : undefined) ??
      (status === 403 ? SECONDARY_LIMIT_WAIT_MS : undefined);
    return new SourceError({
      ...base,
      kind: "rate_limit",
      retryAfterMs,
      message: `${prefix}: rate limited (HTTP ${status})${
        retryAfterMs !== undefined
          ? `; GitHub asks to retry after ${Math.ceil(retryAfterMs / 1000)}s`
          : ""
      }`,
    });
  }
  if (status === 401)
    return new SourceError({
      ...base,
      kind: "authentication",
      message: `${prefix}: authentication failed (HTTP 401); check GITHUB_TOKEN${detail}`,
    });
  if (status === 403)
    return new SourceError({
      ...base,
      kind: "authorization",
      message: `${prefix}: access denied (HTTP 403); the token lacks permission${detail}`,
    });
  if (status === 404)
    return new SourceError({
      ...base,
      kind: "not_found",
      message: `${prefix}: not found (HTTP 404)${detail}`,
    });
  if (status === 408)
    return new SourceError({
      ...base,
      kind: "timeout",
      message: `${prefix}: request timed out (HTTP 408)`,
    });
  if (status >= 500)
    return new SourceError({
      ...base,
      kind: "provider_unavailable",
      message: `${prefix}: GitHub is unavailable (HTTP ${status})`,
    });
  return new SourceError({
    ...base,
    kind: "unknown",
    message: `${prefix}: unexpected response (HTTP ${status})${detail}`,
  });
}

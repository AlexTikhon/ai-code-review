import { SourceError } from "../errors.js";
import {
  executeSourceRequest,
  type SourceRequestEvent,
  type SourceRequestOptions,
  type SourceRetryPolicy,
} from "../request-executor.js";
import { classifyGithubResponse } from "./http-errors.js";

const GITHUB_API_BASE = "https://api.github.com";
/** Enough for GitHub's documented error message; never the whole response. */
const MAX_ERROR_BODY_BYTES = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type GithubOperation = "pull" | "files" | "trusted_policy";
export type GithubRequestMeta = { operation?: GithubOperation; page?: number };
const LABELS: Record<GithubOperation, string> = {
  pull: "pull request metadata",
  files: "pull request files",
  trusted_policy: "trusted ignore policy",
};

/** A GET against the GitHub API with retries; resolves to the parsed JSON. */
export type GithubRequester = <T>(
  path: string,
  signal?: AbortSignal,
  meta?: GithubRequestMeta,
) => Promise<T>;

export type GithubRequesterOptions = {
  /** Defaults to GITHUB_TOKEN, read when a request is made. */
  token?: string;
  /** Per-attempt timeout; the caller's signal never replaces it. */
  requestTimeoutMs?: number;
  policy?: SourceRetryPolicy;
  /** Time left before the total deadline. */
  remainingMs?: () => number;
  onEvent?: (event: SourceRequestEvent) => void;
  /** Test seams. */
  fetch?: typeof fetch;
  /** Wall-clock milliseconds, for the rate-limit reset header. */
  now?: () => number;
  sleep?: SourceRequestOptions<unknown>["sleep"];
  timeoutSignal?: SourceRequestOptions<unknown>["timeoutSignal"];
};

async function readBoundedText(response: Response): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString();
  } catch {
    return "";
  }
}

function networkCode(error: unknown): string | undefined {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code)
    ? code
    : undefined;
}

/**
 * Build the GitHub requester: one HTTP attempt (`attemptOnce`) wrapped by the
 * shared source retry executor. All GitHub operations are GETs, so retrying
 * transient failures is safe. Failures are SourceErrors whose messages carry
 * the operation and status only, never a body, URL or credential.
 */
export function createGithubRequester(
  options: GithubRequesterOptions = {},
): GithubRequester {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async <T>(
    path: string,
    signal?: AbortSignal,
    meta: GithubRequestMeta = {},
  ): Promise<T> => {
    const token = options.token ?? process.env.GITHUB_TOKEN;
    if (!token)
      throw new SourceError({
        kind: "configuration",
        source: "github",
        message: "Missing GITHUB_TOKEN",
        code: "missing_token",
      });
    const label = meta.operation ? LABELS[meta.operation] : "API";

    const attemptOnce = async (
      attemptSignal: AbortSignal,
    ): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
          signal: attemptSignal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      } catch (error) {
        // The executor tells caller cancellation from this attempt's timeout.
        if (attemptSignal.aborted) throw error;
        throw new SourceError({
          kind: "network",
          source: "github",
          message: `GitHub ${label} request failed: network error`,
          code: networkCode(error),
        });
      }
      if (!response.ok)
        throw classifyGithubResponse({
          status: response.status,
          headers: response.headers,
          bodyText: await readBoundedText(response),
          label,
          now: now(),
        });
      try {
        return await response.json();
      } catch (error) {
        if (attemptSignal.aborted) throw error;
        throw new SourceError({
          kind: "invalid_response",
          source: "github",
          message: `GitHub ${label} request failed: the response was not valid JSON`,
          statusCode: response.status,
        });
      }
    };

    return (await executeSourceRequest({
      source: "github",
      attempt: attemptOnce,
      signal,
      attemptTimeoutMs: requestTimeoutMs,
      policy: options.policy,
      remainingMs: options.remainingMs,
      sleep: options.sleep,
      timeoutSignal: options.timeoutSignal,
      onEvent: (event) =>
        options.onEvent?.({
          ...event,
          ...(meta.operation ? { operation: meta.operation } : {}),
          ...(meta.page !== undefined ? { page: meta.page } : {}),
        }),
    })) as T;
  };
}

/** The default requester: GITHUB_TOKEN, real fetch, three attempts. */
export const githubRequest: GithubRequester = createGithubRequester();

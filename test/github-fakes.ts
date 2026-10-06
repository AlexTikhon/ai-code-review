import {
  createGithubRequester,
  type GithubRequesterOptions,
} from "../src/review-sources/github/client.js";
import type { SourceRequestEvent } from "../src/review-sources/request-executor.js";

/** One scripted HTTP outcome. The last entry repeats once the script runs out. */
export type Reply =
  | {
      status?: number;
      headers?: Record<string, string>;
      json?: unknown;
      text?: string;
    }
  | { fail: Error }
  | { hang: true };

export type FakeCall = {
  url: string;
  headers: Headers;
  signal: AbortSignal;
};

export const NOW = 1_700_000_000_000;
export const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

/** A fetch that answers from a script and honors its abort signal. */
export function scriptedFetch(replies: Reply[]) {
  const calls: FakeCall[] = [];
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      signal,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if ("fail" in reply) return Promise.reject(reply.fail);
    if ("hang" in reply)
      return new Promise<Response>((_, reject) => {
        const abort = () =>
          reject(new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const body =
      reply.text !== undefined ? reply.text : JSON.stringify(reply.json ?? {});
    return Promise.resolve(
      new Response(body, {
        status: reply.status ?? 200,
        headers: reply.headers,
      }),
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/**
 * A fetch that answers by route. `seen` counts earlier requests to the same
 * path and query, so a handler can change its answer on a later request.
 */
export function routedFetch(
  route: (url: URL, seen: number, call: number) => Reply,
) {
  const counts = new Map<string, number>();
  const urls: string[] = [];
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    urls.push(key);
    const reply = route(url, seen, urls.length);
    const scripted = scriptedFetch([reply]);
    return scripted.fetch(input as string, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, urls };
}

/** Everything a test may need to observe: waits, timers, events, requests. */
export function fakeGithub(
  replies: Reply[],
  overrides: Partial<GithubRequesterOptions> = {},
) {
  const { fetch, calls } = scriptedFetch(replies);
  return fakeGithubWith(fetch, calls, overrides);
}

export function fakeGithubRouted(
  route: (url: URL, seen: number, call: number) => Reply,
  overrides: Partial<GithubRequesterOptions> = {},
) {
  const { fetch, urls } = routedFetch(route);
  return { ...fakeGithubWith(fetch, [], overrides), urls };
}

function fakeGithubWith(
  fetch: typeof globalThis.fetch,
  calls: FakeCall[],
  overrides: Partial<GithubRequesterOptions>,
) {
  const sleeps: number[] = [];
  const timeouts: Array<{ ms: number; fire: () => void }> = [];
  const events: SourceRequestEvent[] = [];
  const request = createGithubRequester({
    token: TOKEN,
    fetch,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      timeouts.push({
        ms,
        fire: () =>
          controller.abort(new DOMException("timed out", "TimeoutError")),
      });
      return controller.signal;
    },
    requestTimeoutMs: 30_000,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { request, calls, sleeps, timeouts, events };
}

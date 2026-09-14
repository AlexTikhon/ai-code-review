import { setTimeout as delay } from "node:timers/promises";
import type { EventSink } from "../observability/events.js";
import { emitEvent } from "../observability/events.js";
import {
  ModelError,
  type ModelRequest,
  type ModelResult,
  type ReviewModel,
} from "./types.js";
export async function executeModel(input: {
  model: ReviewModel;
  request: ModelRequest;
  runId: string;
  filename: string;
  maxAttempts: number;
  requestTimeoutMs: number;
  totalSignal: AbortSignal;
  events: EventSink;
}): Promise<{ result: ModelResult; attempts: number }> {
  let last: unknown;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    if (input.totalSignal.aborted)
      throw new Error("Total review deadline exceeded");
    const requestSignal = AbortSignal.any([
      input.totalSignal,
      AbortSignal.timeout(input.requestTimeoutMs),
    ]);
    emitEvent(input.events, input.runId, "analyze", "request", {
      filename: input.filename,
      attempt,
    });
    try {
      return {
        result: await input.model.review(input.request, requestSignal),
        attempts: attempt,
      };
    } catch (error) {
      last = error;
      const retryable =
        error instanceof ModelError
          ? error.retryable
          : error instanceof TypeError;
      if (
        !retryable ||
        attempt === input.maxAttempts ||
        requestSignal.aborted
      ) {
        if (error && typeof error === "object")
          Object.assign(error, { attempts: attempt });
        throw error;
      }
      const wait =
        error instanceof ModelError && error.retryAfterMs
          ? Math.min(error.retryAfterMs, 10000)
          : Math.min(250 * 2 ** (attempt - 1), 2000);
      await delay(wait, undefined, { signal: input.totalSignal });
    }
  }
  throw last;
}

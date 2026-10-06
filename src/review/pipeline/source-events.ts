import { emitEvent, type ReviewEvent } from "../../observability/events.js";
import type { SourceRequestEvent } from "../../review-sources/request-executor.js";
import type { PipelineContext } from "./types.js";

const TYPE: Record<SourceRequestEvent["type"], ReviewEvent["type"]> = {
  request_started: "request",
  request_retry: "warning",
  request_succeeded: "complete",
  request_failed: "error",
};

/**
 * Source-request diagnostics: operation, page, attempt, status, error kind,
 * retryability and timings. Never a URL, token, response body or repository text.
 */
export function sourceEventSink(
  ctx: PipelineContext,
  source: "github",
): (event: SourceRequestEvent) => void {
  return ({ type, attempt, durationMs, ...facts }) =>
    emitEvent(ctx.events, ctx.runId, "source", TYPE[type], {
      message: `${source}.${type}`,
      attempt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      data: {
        source,
        ...(Object.fromEntries(
          Object.entries(facts).filter(([, value]) => value !== undefined),
        ) as Record<string, string | number | boolean>),
      },
    });
}

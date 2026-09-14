export type ReviewEvent = {
  runId: string;
  stage: string;
  type: "start" | "complete" | "warning" | "error" | "request" | "context";
  timestamp: string;
  durationMs?: number;
  filename?: string;
  attempt?: number;
  message?: string;
  data?: Record<string, string | number | boolean>;
};
export type EventSink = (event: ReviewEvent) => void;
export const noOpEventSink: EventSink = () => undefined;
export function emitEvent(
  sink: EventSink,
  runId: string,
  stage: string,
  type: ReviewEvent["type"],
  fields: Omit<ReviewEvent, "runId" | "stage" | "type" | "timestamp"> = {},
): void {
  sink({ runId, stage, type, timestamp: new Date().toISOString(), ...fields });
}

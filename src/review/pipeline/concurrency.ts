export type PoolResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown }
  | { status: "not-started" };

/**
 * Run `worker` over `items` with at most `limit` jobs in flight.
 *
 * Unlike fixed batches, a free worker immediately takes the next item, so one
 * slow job never idles the others. Guarantees:
 * - no job starts once `signal` is aborted (checked synchronously at start);
 * - a rejected job is recorded for that item only and never cancels siblings;
 * - results are returned in input order regardless of completion order, so
 *   aggregation downstream is deterministic.
 * Items that never started are reported as "not-started" so callers can account
 * for them explicitly instead of losing them.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = items.map(() => ({
    status: "not-started" as const,
  }));
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length && !signal.aborted) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index]!, index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

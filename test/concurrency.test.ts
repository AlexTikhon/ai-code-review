import assert from "node:assert/strict";
import { runBounded } from "../src/review/pipeline/concurrency.js";
import { deferred, nextTick } from "./fixtures.js";
import { unitTest } from "./helpers.js";

const live = () => new AbortController().signal;

unitTest("worker pool never exceeds the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const results = await runBounded(
    [1, 2, 3, 4, 5, 6, 7, 8],
    3,
    live(),
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      await nextTick();
      active--;
      return n * 2;
    },
  );
  assert.equal(peak, 3);
  assert.deepEqual(
    results.map((r) => (r.status === "fulfilled" ? r.value : undefined)),
    [2, 4, 6, 8, 10, 12, 14, 16],
  );
});

unitTest(
  "a slow job does not hold back work that an idle worker can take",
  async () => {
    const slow = deferred();
    const started: string[] = [];
    const run = runBounded(["A", "B", "C", "D"], 2, live(), async (name) => {
      started.push(name);
      if (name === "A") await slow.promise;
      return name;
    });
    await nextTick();
    // With fixed batches C and D would wait for A; a pool starts them at once.
    assert.deepEqual(started, ["A", "B", "C", "D"]);
    slow.resolve();
    const results = await run;
    assert.deepEqual(
      results.map((r) => (r.status === "fulfilled" ? r.value : undefined)),
      ["A", "B", "C", "D"],
    );
  },
);

unitTest("results follow input order, not completion order", async () => {
  const first = deferred<string>();
  const run = runBounded([0, 1], 2, live(), (index) =>
    index === 0 ? first.promise : Promise.resolve("fast"),
  );
  await nextTick();
  first.resolve("slow");
  const results = await run;
  assert.deepEqual(results, [
    { status: "fulfilled", value: "slow" },
    { status: "fulfilled", value: "fast" },
  ]);
});

unitTest("no job starts after the signal is aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const results = await runBounded(
    [1, 2, 3, 4],
    1,
    controller.signal,
    async (n) => {
      calls++;
      controller.abort();
      return n;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "not-started", "not-started", "not-started"],
  );

  const aborted = new AbortController();
  aborted.abort();
  let none = 0;
  const skipped = await runBounded([1, 2], 2, aborted.signal, async () => {
    none++;
  });
  assert.equal(none, 0);
  assert.ok(skipped.every((r) => r.status === "not-started"));
});

unitTest("a failing job is isolated and does not cancel siblings", async () => {
  const results = await runBounded([1, 2, 3], 2, live(), async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(results[2]?.status, "fulfilled");
});

unitTest("empty input and non-positive limits are handled", async () => {
  assert.deepEqual(await runBounded([], 4, live(), async () => 1), []);
  const results = await runBounded([1, 2], 0, live(), async (n) => n);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
});

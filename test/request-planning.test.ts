import assert from "node:assert/strict";
import { reviewCacheKey } from "../src/cache/review-cache.js";
import { loadConfig, type ReviewConfig } from "../src/config/config.js";
import { ExternalRequestBudget } from "../src/model/budget.js";
import type { ModelRequest, ReviewModel } from "../src/model/types.js";
import { estimatePromptTokens } from "../src/prompts/estimate.js";
import {
  assembleReviewPrompt,
  renderReviewMetadata,
} from "../src/prompts/review.js";
import type { EmbeddingAdapter } from "../src/retrieval/embeddings.js";
import type { ContextChunk } from "../src/retrieval/types.js";
import { reviewFile } from "../src/review/pipeline/review-file.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { PipelineContext } from "../src/review/pipeline/types.js";
import {
  estimateSegmentRequest,
  planReviewSegments,
  requestBudgetProblem,
} from "../src/review/request-plan.js";
import { planPatchSegments } from "../src/review/patch.js";
import type { PatchSegment } from "../src/review/types.js";
import { cleanResult, makeSource, request, testConfig } from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { repo } from "./index-harness.js";

/** The repository defaults (src/config/config.ts), with test-only plumbing. */
const defaultConfig: ReviewConfig = {
  ...testConfig,
  maxInputTokens: 8000,
  maxOutputTokens: 1200,
  maxMetadataCharacters: 4000,
  maxPatchTokens: 4000,
  maxContextTokens: 1800,
  maxSegmentsPerFile: 4,
  maxRequests: 200,
};

const additions = (count: number, start = 1) =>
  `@@ -0,0 +${start},${count} @@\n` +
  Array.from({ length: count }, (_, i) => `+const value${i} = ${i};`).join(
    "\n",
  );

const file = (filename: string, patch: string) => ({
  filename,
  status: "added",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch,
});

const subject = (filename = "a.ts") => ({
  title: "t",
  description: "d",
  filename,
  fileType: "source" as const,
});

const usableOf = (config: ReviewConfig) =>
  config.maxInputTokens - config.maxOutputTokens;

/** A mocked provider that records exactly what it was sent. */
function recordingModel(provider = "recording") {
  const requests: ModelRequest[] = [];
  const model: ReviewModel = {
    provider,
    async review(sent) {
      requests.push(sent);
      return cleanResult();
    },
  };
  return { model, requests };
}

const planFor = (
  patch: string,
  budget: Partial<ReviewConfig> = {},
  filename = "a.ts",
) =>
  planReviewSegments(patch, subject(filename), { ...defaultConfig, ...budget });

/** Complete (citable) added lines across segments, in plan order. */
function citableNewLines(segments: PatchSegment[]): number[] {
  return segments.flatMap((segment) =>
    segment.lineMappings
      .filter((line) => line.kind === "addition" && line.complete)
      .map((line) => line.newLine!),
  );
}

unitTest(
  "default config: 60 short added declarations reach the model within budget",
  async () => {
    const { model, requests } = recordingModel();
    const result = await executeReviewPipeline(request, defaultConfig, {
      model,
      source: makeSource([file("a.ts", additions(60))]),
    });
    assert.deepEqual(result.errors, []);
    assert.ok(requests.length > 0, "the mocked model was never reached");
    assert.equal(result.status, "complete");
    assert.equal(result.coverage.truncated, 0);
    for (const sent of requests)
      assert.ok(estimatePromptTokens(sent) <= usableOf(defaultConfig));
  },
);

unitTest(
  "planned segments are deterministic and keep exact line coordinates",
  () => {
    const first = planFor(additions(60, 10));
    const second = planFor(additions(60, 10));
    assert.deepEqual(first, second);
    assert.deepEqual(
      citableNewLines(first.segments),
      Array.from({ length: 60 }, (_, i) => 10 + i),
    );
    assert.equal(first.truncated, false);
    for (const segment of first.segments) {
      // Offsets and ranges are local to the final segment, not a larger one.
      const lines = segment.text.split("\n");
      for (const mapping of segment.lineMappings)
        assert.ok(lines[mapping.segmentLine - 1]?.startsWith("+"));
      assert.ok(segment.lineRanges.length > 0);
    }
  },
);

unitTest("exact fit stays one segment; one token less must split", () => {
  const patch = additions(40);
  const whole = planFor(patch, { maxPatchTokens: 100_000 });
  assert.equal(whole.segments.length, 1);
  const exact = estimateSegmentRequest(
    subject(),
    whole.segments[0]!,
    defaultConfig,
  );
  const budget = (usable: number) => ({
    maxPatchTokens: 100_000,
    maxOutputTokens: 1200,
    maxInputTokens: 1200 + usable,
  });
  const atLimit = planFor(patch, budget(exact));
  assert.equal(atLimit.segments.length, 1);
  assert.equal(atLimit.segments[0]!.id, whole.segments[0]!.id);
  const under = planFor(patch, budget(exact - 1));
  assert.ok(under.segments.length > 1);
  assert.equal(citableNewLines(under.segments).length, 40);
});

unitTest(
  "every dispatched request fits with dense mapping, long path and multibyte text",
  async () => {
    const config = {
      ...defaultConfig,
      maxInputTokens: 12_000,
      maxOutputTokens: 600,
      maxPatchTokens: 100_000,
      maxSegmentsPerFile: 50,
      maxMetadataCharacters: 4000,
    };
    const filename = `${"deep/".repeat(40)}файл-😀.ts`;
    const title = "😀".repeat(3000);
    const description = "d".repeat(9000);
    const patch =
      "@@ -5,3 +5,200 @@\n context\n-gone\n" +
      Array.from({ length: 200 }, (_, i) => `+const é${i} = "😀${i}";`).join(
        "\n",
      );
    const { model, requests } = recordingModel();
    const result = await executeReviewPipeline(request, config, {
      model,
      source: makeSource([file(filename, patch)], { title, description }),
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.status, "complete");
    assert.ok(requests.length > 3);
    for (const sent of requests)
      assert.ok(estimatePromptTokens(sent) <= usableOf(config));
    // The metadata in the request is the exact representation that was sized.
    const metadata = renderReviewMetadata({
      title,
      description,
      filename,
      fileType: "source",
      maxMetadataCharacters: config.maxMetadataCharacters,
    });
    for (const sent of requests) assert.ok(sent.user.includes(metadata));
    assert.equal(
      result.usage.estimatedInputTokens,
      requests.reduce((sum, sent) => sum + estimatePromptTokens(sent), 0),
    );
  },
);

unitTest(
  "an oversized line is split into uncitable fragments and the plan is partial",
  async () => {
    const patch = `@@ -1 +7,2 @@\n+${"😀".repeat(5000)}\n+tail();`;
    const plan = planFor(patch, { maxSegmentsPerFile: 3 });
    assert.equal(plan.truncated, true);
    assert.ok(plan.segments.length <= 3);
    for (const segment of plan.segments) {
      assert.ok(segment.truncated);
      assert.ok(
        estimateSegmentRequest(subject(), segment, defaultConfig) <=
          usableOf(defaultConfig),
      );
      for (const mapping of segment.lineMappings.filter(
        (line) => line.newLine === 7,
      ))
        assert.equal(mapping.complete, false);
      assert.ok(!segment.lineRanges.some((r) => r.start <= 7 && r.end >= 7));
    }
    const { model, requests } = recordingModel();
    const result = await executeReviewPipeline(request, defaultConfig, {
      model,
      source: makeSource([file("a.ts", patch)]),
    });
    assert.ok(requests.length > 0);
    assert.equal(result.status, "partial");
    assert.equal(result.coverage.truncated, 1);
    assert.deepEqual(result.errors, []);
  },
);

unitTest(
  "segment-cap overflow keeps the planned prefix and reports partial coverage",
  async () => {
    const config = { ...defaultConfig, maxSegmentsPerFile: 2 };
    const plan = planFor(additions(400), { maxSegmentsPerFile: 2 });
    assert.equal(plan.segments.length, 2);
    assert.equal(plan.truncated, true);
    assert.ok(plan.segments.every((segment) => segment.truncated));
    const planned = citableNewLines(plan.segments);
    assert.deepEqual(
      planned,
      Array.from({ length: planned.length }, (_, i) => 1 + i),
      "the prefix is contiguous from the start",
    );
    assert.ok(planned.length < 400);
    const { model, requests } = recordingModel();
    const result = await executeReviewPipeline(request, config, {
      model,
      source: makeSource([file("a.ts", additions(400))]),
    });
    assert.equal(requests.length, 2);
    assert.equal(result.status, "partial");
    assert.equal(result.coverage.truncated, 1);
    assert.equal(result.coverage.reviewed, 1);
    assert.match(result.summary, /truncated 1/);
  },
);

unitTest(
  "a file whose mandatory request cannot fit is omitted; siblings still review",
  async () => {
    const { model, requests } = recordingModel();
    const hopeless = `${"p".repeat(9000)}.ts`;
    const result = await executeReviewPipeline(request, defaultConfig, {
      model,
      source: makeSource([
        file(hopeless, additions(3)),
        file("ok.ts", additions(3)),
      ]),
    });
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.user.includes('"filename":"ok.ts"'));
    assert.equal(result.status, "partial");
    assert.equal(result.coverage.omitted, 1);
    assert.equal(result.coverage.reviewed, 1);
    const skipped = result.skippedFiles.find((f) => f.filename === hopeless);
    assert.equal(skipped?.reason, "work_limit");
    assert.match(skipped?.details ?? "", /leaves no room/);
    const alone = await executeReviewPipeline(request, defaultConfig, {
      model,
      source: makeSource([file(hopeless, additions(3))]),
    });
    assert.equal(alone.status, "failed");
    assert.equal(requests.length, 1, "nothing was sent for the hopeless file");
  },
);

unitTest("impossible budgets are rejected by config validation", () => {
  assert.match(
    requestBudgetProblem({ maxInputTokens: 1000, maxOutputTokens: 1000 }) ?? "",
    /must be smaller than/,
  );
  assert.match(
    requestBudgetProblem({ maxInputTokens: 3000, maxOutputTokens: 1200 }) ?? "",
    /fixed prompt, response schema and framing/,
  );
  assert.equal(
    requestBudgetProblem({ maxInputTokens: 8000, maxOutputTokens: 1200 }),
    undefined,
  );
  const keys = ["AI_REVIEW_MAX_INPUT_TOKENS", "AI_REVIEW_MAX_OUTPUT_TOKENS"];
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.AI_REVIEW_MAX_INPUT_TOKENS = "2000";
    process.env.AI_REVIEW_MAX_OUTPUT_TOKENS = "2000";
    assert.throws(
      () => loadConfig({ allowExternal: false }),
      /AI_REVIEW_MAX_OUTPUT_TOKENS \(2000\) must be smaller/,
    );
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});

unitTest(
  "dry-run plans exactly what execution sends in diff mode",
  async () => {
    for (const patch of ["@@ -0,0 +1 @@\n+a", additions(60), additions(400)]) {
      const source = makeSource([file("a.ts", patch)]);
      const dry = await executeReviewPipeline(
        { ...request, dryRun: true },
        defaultConfig,
        { source },
      );
      const { model, requests } = recordingModel();
      const real = await executeReviewPipeline(request, defaultConfig, {
        model,
        source,
      });
      const manifest = dry.dryRun!;
      assert.equal(manifest.estimatedRequests, requests.length);
      assert.equal(manifest.proposedFiles[0]!.segments, requests.length);
      assert.equal(
        manifest.estimatedInputTokens,
        requests.reduce((sum, sent) => sum + estimatePromptTokens(sent), 0),
      );
      assert.equal(
        manifest.estimatedInputTokens,
        real.usage.estimatedInputTokens,
      );
      assert.equal(manifest.contextTokenBound, 0);
      assert.equal(manifest.inputTokenBound, manifest.estimatedInputTokens);
      assert.equal(dry.usage.actualRequests, 0);
    }
    const tiny = await executeReviewPipeline(
      { ...request, dryRun: true },
      defaultConfig,
      { source: makeSource([file("a.ts", "@@ -0,0 +1 @@\n+a")]) },
    );
    assert.ok(
      tiny.dryRun!.estimatedInputTokens > 1000,
      "a few patch bytes still carry the full fixed request",
    );
  },
);

unitTest(
  "context-mode dry-run makes no calls and reports a bound, not a total",
  async () => {
    const root = await repo({
      "src/m.ts": "export function work() { return 1; }\n",
    });
    let embeddings = 0;
    let models = 0;
    const embedding = {
      provider: "spy",
      model: "spy",
      async embed(texts: string[]) {
        embeddings++;
        return texts.map(() => [0]);
      },
    } as unknown as EmbeddingAdapter;
    const model: ReviewModel = {
      provider: "spy",
      async review() {
        models++;
        return cleanResult();
      },
    };
    const source = makeSource([file("a.ts", additions(60))], {
      repositoryRoot: root,
    });
    for (const contextMode of ["lexical", "hybrid"] as const) {
      const dry = await executeReviewPipeline(
        { ...request, contextMode, dryRun: true },
        defaultConfig,
        { source, model, embedding },
      );
      const manifest = dry.dryRun!;
      assert.equal(dry.context.state, "used");
      assert.ok(manifest.contextTokenBound > 0);
      assert.equal(
        manifest.inputTokenBound,
        manifest.estimatedInputTokens + manifest.contextTokenBound,
      );
      assert.ok(
        manifest.inputTokenBound <=
          manifest.estimatedRequests * usableOf(defaultConfig),
      );
      assert.match(manifest.estimateBasis, /not provider billing-token counts/);
      assert.match(manifest.estimateBasis, /not known without calling/);
    }
    assert.equal(embeddings, 0);
    assert.equal(models, 0);
  },
);

unitTest("context only fills what the mandatory request leaves", () => {
  const segment = planFor(additions(5)).segments[0]!;
  const input = {
    title: "t",
    description: "d",
    filename: "a.ts",
    fileType: "source" as const,
    segment,
    maxInputTokens: 8000,
    outputReservation: 1200,
    maxMetadataCharacters: 4000,
    maxContextTokens: 1800,
  };
  const chunk = (id: string, size: number): ContextChunk => ({
    id,
    repositoryId: "r",
    revision: "v",
    path: "ctx.ts",
    language: "typescript",
    kind: "symbol",
    imports: [],
    startLine: 1,
    endLine: 2,
    content: "x".repeat(size),
    contentHash: id,
    contentComplete: true,
  });
  const bare = assembleReviewPrompt({ ...input, contexts: [] });
  const huge = assembleReviewPrompt({
    ...input,
    maxContextTokens: 1_000_000,
    contexts: [chunk("big", 50_000)],
  });
  assert.deepEqual(huge.context, []);
  assert.equal(huge.user, bare.user, "diff request is unchanged");
  const small = assembleReviewPrompt({
    ...input,
    contexts: [chunk("a", 300)],
  });
  assert.equal(small.context.length, 1);
  assert.ok(small.estimatedInputTokens <= 6800);
  // Different request text is a different exact-request cache identity.
  const model = { provider: "p", identity: "i" };
  const keyOf = (prompt: typeof bare) =>
    reviewCacheKey(
      {
        system: prompt.system,
        user: prompt.user,
        model: "m",
        maxOutputTokens: 1,
      },
      model,
    );
  assert.notEqual(keyOf(small), keyOf(bare));
  assert.equal(
    keyOf(bare),
    keyOf(assembleReviewPrompt({ ...input, contexts: [] })),
  );
});

unitTest(
  "the same planned requests reach every provider contract unchanged",
  async () => {
    const seen: string[] = [];
    for (const provider of ["openai", "anthropic", "other"]) {
      const { model, requests } = recordingModel(provider);
      await executeReviewPipeline(request, defaultConfig, {
        model,
        source: makeSource([file("a.ts", additions(60))]),
      });
      seen.push(JSON.stringify(requests));
    }
    assert.equal(new Set(seen).size, 1);
  },
);

unitTest(
  "a segment that bypasses the plan is rejected before any provider call",
  async () => {
    let calls = 0;
    const oversized: PatchSegment = {
      id: "f".repeat(16),
      text: `+${"x".repeat(20_000)}`,
      lineRanges: [{ start: 1, end: 1 }],
      lineMappings: [
        { segmentLine: 1, kind: "addition", newLine: 1, complete: true },
      ],
      truncated: false,
    };
    const controller = new AbortController();
    const ctx: PipelineContext = {
      runId: "r",
      request,
      config: defaultConfig,
      model: {
        provider: "test",
        async review() {
          calls++;
          return cleanResult();
        },
      },
      events: () => {},
      now: Date.now,
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      budget: new ExternalRequestBudget(10, controller.signal),
    };
    const outcome = await reviewFile(ctx, {
      order: 0,
      source: makeSource([]),
      file: {
        ...file("a.ts", ""),
        fileType: "source",
        segments: [oversized],
        truncated: false,
        originalPatchCharacters: 0,
      },
    });
    assert.equal(calls, 0);
    assert.equal(outcome.failed, true);
    assert.equal(outcome.errors[0]?.code, "ANALYSIS_FAILED");
  },
);

unitTest(
  "a line that cannot be fragmented is dropped, never faked, and flagged",
  () => {
    const patch = `@@ -0,0 +1,3 @@\n+first();\n+${"y".repeat(500)}\n+last();`;
    // A budget that refuses every incomplete fragment of the long line.
    const plan = planPatchSegments(
      patch,
      4,
      (segment) =>
        segment.text.length <= 60 &&
        segment.lineMappings.every((line) => line.complete),
    );
    assert.equal(plan.truncated, true);
    assert.ok(plan.segments.every((segment) => segment.truncated));
    assert.deepEqual(citableNewLines(plan.segments), [1, 3]);
    assert.ok(plan.segments.every((s) => !s.text.includes("yyyy")));
  },
);

unitTest("planning a very large patch is exact and bounded", () => {
  const plan = planFor(additions(20_000), {
    maxInputTokens: 200_000,
    maxPatchTokens: 100_000,
    maxSegmentsPerFile: 40,
  });
  assert.ok(plan.segments.length >= 2 && plan.segments.length <= 40);
  const lines = citableNewLines(plan.segments);
  assert.deepEqual(
    lines,
    Array.from({ length: lines.length }, (_, i) => 1 + i),
  );
  for (const segment of plan.segments)
    assert.ok(
      estimateSegmentRequest(subject(), segment, {
        ...defaultConfig,
        maxInputTokens: 200_000,
      }) <=
        200_000 - defaultConfig.maxOutputTokens,
    );
});

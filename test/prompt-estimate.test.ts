import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MESSAGE_FRAMING_TOKENS,
  RESPONSE_SCHEMA_TOKENS,
  estimatePromptTokens,
} from "../src/prompts/estimate.js";
import {
  REVIEW_SYSTEM_PROMPT,
  assembleReviewPrompt,
} from "../src/prompts/review.js";
import { estimateTokens, splitPatchForReview } from "../src/review/patch.js";
import { REVIEW_JSON_SCHEMA } from "../src/schemas/review.schema.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewModel } from "../src/model/types.js";
import {
  cleanResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";

const segment = splitPatchForReview("@@ -1 +1 @@\n+const a = 1;", 300, 1)[0]!;
const assemble = (
  contexts: Parameters<typeof assembleReviewPrompt>[0]["contexts"],
) =>
  assembleReviewPrompt({
    title: "t",
    description: "d",
    filename: "a.ts",
    fileType: "source",
    segment,
    contexts,
    maxInputTokens: 8000,
    outputReservation: 200,
    maxMetadataCharacters: 200,
    maxContextTokens: 1800,
  });
const chunk = (id: string, size: number) => ({
  id,
  repositoryId: "r",
  revision: "v",
  path: "ctx.ts",
  language: "typescript" as const,
  kind: "symbol" as const,
  imports: [],
  startLine: 1,
  endLine: 2,
  content: "x".repeat(size),
  contentHash: id,
  contentComplete: true,
});

unitTest(
  "the estimate is the shared prompt plus the shared schema and framing",
  () => {
    const prompt = { system: "sys", user: "ü user" };
    assert.equal(
      estimatePromptTokens(prompt),
      estimateTokens("sys") +
        estimateTokens("ü user") +
        RESPONSE_SCHEMA_TOKENS +
        MESSAGE_FRAMING_TOKENS,
    );
    assert.equal(
      RESPONSE_SCHEMA_TOKENS,
      estimateTokens(JSON.stringify(REVIEW_JSON_SCHEMA)),
      "derived from the provider-neutral schema, not a provider request",
    );
    assert.equal(estimatePromptTokens(prompt), estimatePromptTokens(prompt));
  },
);

unitTest("prompt assembly reports exactly the neutral estimate", () => {
  const prompt = assemble([]);
  assert.equal(
    prompt.estimatedInputTokens,
    estimatePromptTokens({ system: REVIEW_SYSTEM_PROMPT, user: prompt.user }),
  );
});

unitTest(
  "more repository context raises the estimate deterministically",
  () => {
    const none = assemble([]).estimatedInputTokens;
    const one = assemble([chunk("a", 400)]).estimatedInputTokens;
    const two = assemble([
      chunk("a", 400),
      chunk("b", 400),
    ]).estimatedInputTokens;
    assert.ok(none < one && one < two);
    assert.equal(assemble([chunk("a", 400)]).estimatedInputTokens, one);
  },
);

unitTest(
  "the generic prompt code has no provider request shape in it",
  async () => {
    for (const file of ["src/prompts/review.ts", "src/prompts/estimate.ts"]) {
      const text = await readFile(file, "utf8");
      assert.doesNotMatch(text, /openai|response_format|"json_schema"/i, file);
    }
  },
);

unitTest(
  "the same prompt has the same estimate whichever provider reviews it",
  async () => {
    const estimates: number[] = [];
    for (const provider of ["openai", "anthropic", "test"]) {
      const model: ReviewModel = {
        provider,
        async review() {
          return cleanResult(777);
        },
      };
      const result = await executeReviewPipeline(request, testConfig, {
        model,
        source: makeSource([sourceFile("a.ts")]),
      });
      estimates.push(result.usage.estimatedInputTokens);
      // What the provider reports is actual usage, never the estimate.
      assert.equal(result.usage.inputTokens, 777);
      assert.equal(result.usage.estimated, false);
    }
    assert.equal(new Set(estimates).size, 1);
    assert.ok(estimates[0]! > 0 && estimates[0]! !== 777);
  },
);

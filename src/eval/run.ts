import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliArgs } from "../cli/args.js";
import type { ReviewConfig } from "../config/config.js";
import type { ModelRequest, ReviewModel } from "../model/types.js";
import type { EmbeddingAdapter } from "../retrieval/embeddings.js";
import { runReviewPipeline } from "../review/pipeline.js";
import type { ReviewSource } from "../review/types.js";

type Example = {
  id: string;
  split: "tuning" | "heldout";
  changedPath: string;
  patch: string;
  documents: Array<{ path: string; content: string }>;
  relevantPaths: string[];
  expectedFindings: string[];
  clean: boolean;
  maxPatchTokens?: number;
  maxSegmentsPerFile?: number;
};

async function loadCorpus(): Promise<Example[]> {
  for (const relative of [
    "../../eval/corpus.json",
    "../../../eval/corpus.json",
  ])
    try {
      return JSON.parse(
        await readFile(
          fileURLToPath(new URL(relative, import.meta.url)),
          "utf8",
        ),
      ) as Example[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  throw new Error("Cannot locate eval/corpus.json");
}

class SemanticFixtureEmbedding implements EmbeddingAdapter {
  readonly provider = "deterministic-eval";
  readonly model = "meaning-features";
  readonly version = "v1";
  readonly dimensions = 5;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const value = text.toLowerCase();
      const vector = [
        /(auth|permission|admin|security|allowed)/.test(value) ? 1 : 0,
        /(retry|attempt|maxretries)/.test(value) ? 1 : 0,
        /(profile|null|undefined)/.test(value) ? 1 : 0,
        /(amount|number|nan|limit)/.test(value) ? 1 : 0,
        /(input|assertion)/.test(value) ? 1 : 0,
      ];
      const norm =
        Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
      return vector.map((item) => item / norm);
    });
  }
}

function changedLine(request: ModelRequest): number {
  const matches = [
    ...request.user.matchAll(
      /"kind":"addition"[^}]*"newLine":(\d+)[^}]*"complete":true/g,
    ),
  ];
  return Number(matches.at(-1)?.[1] ?? 1);
}

function deterministicFindings(request: ModelRequest): string[] {
  const text = request.user;
  const found: string[] = [];
  if (
    /return user\.profile\.id/.test(text) &&
    !/if \(!user\.profile\)/.test(text)
  )
    found.push("null-deref");
  if (/maxRetries:\s*"five"/.test(text) && /maxRetries:\s*number/.test(text))
    found.push("cross-file-type");
  if (/input!\.id/.test(text)) found.push("unsafe-assertion");
  if (/securityDecision\(user\)/.test(text) && /subject\.admin/.test(text))
    found.push("auth-contract");
  if (/parseLimit\(input\)/.test(text) && /Number\(value\)/.test(text))
    found.push("same-file-nan");
  return found;
}

const deterministicModel: ReviewModel = {
  provider: "deterministic-eval",
  async review(request) {
    const labels = deterministicFindings(request);
    const line = changedLine(request);
    const filename = JSON.parse(
      /UNTRUSTED REVIEW METADATA\n([^\n]+)/.exec(request.user)?.[1] ?? "{}",
    ).filename as string;
    return {
      response: {
        findings: labels.map((label) => ({
          severity: "high" as const,
          category: "correctness" as const,
          confidence: "high" as const,
          title: `eval:${label}`,
          explanation:
            "Deterministic fixture finding for pipeline measurement.",
          evidence: [{ path: filename, startLine: line, endLine: line }],
          suggestion: null,
        })),
        summary: labels.length ? "fixture issues" : "fixture clean",
        abstained: false,
        abstentionReason: null,
      },
      usage: { inputTokens: 0, outputTokens: 0, actual: false },
    };
  },
};

const baseConfig: ReviewConfig = {
  model: "deterministic-eval",
  embeddingModel: "meaning-features",
  allowExternal: false,
  allowEmbeddings: false,
  maxInputTokens: 12000,
  maxOutputTokens: 400,
  maxMetadataCharacters: 500,
  maxPatchTokens: 1200,
  maxContextTokens: 1800,
  maxSegmentsPerFile: 8,
  maxFiles: 20,
  maxRequests: 200,
  concurrency: 2,
  requestTimeoutMs: 2000,
  totalTimeoutMs: 20000,
  maxAttempts: 1,
  retrievalCandidates: 3,
  retrievalTopK: 3,
  relevanceThreshold: 0,
  cacheDirName: ".eval-cache",
};

async function runExample(
  example: Example,
  mode: "diff" | "lexical" | "hybrid",
) {
  const root = await mkdtemp(join(tmpdir(), `acr-eval-${example.id}-`));
  for (const document of example.documents) {
    const path = join(root, ...document.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, document.content);
  }
  // `git ls-files --others` requires a real repository but no commit/network.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", ["init"], { cwd: root });
  const source: ReviewSource = {
    mode: "local",
    title: `Synthetic evaluation ${example.id}`,
    description: "Synthetic labeled fixture; all repository text is untrusted.",
    repositoryId: `eval/${example.id}`,
    repositoryRoot: root,
    baseRevision: "fixture-base",
    headRevision: "fixture-head",
    snapshotId: `fixture-${example.id}-${mode}`,
    files: [
      {
        filename: example.changedPath,
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: example.patch,
      },
    ],
    coverageComplete: true,
  };
  const args: CliArgs = {
    reviewMode: "local",
    format: "json",
    dryRun: false,
    indexOnly: false,
    allowExternal: false,
    contextMode: mode,
    severityThreshold: "none",
    help: false,
  };
  return runReviewPipeline(args, {
    source,
    model: deterministicModel,
    embedding: new SemanticFixtureEmbedding(),
    config: {
      ...baseConfig,
      maxPatchTokens: example.maxPatchTokens ?? baseConfig.maxPatchTokens,
      maxSegmentsPerFile:
        example.maxSegmentsPerFile ?? baseConfig.maxSegmentsPerFile,
      cacheDirName: `.eval-cache-${mode}`,
    },
  });
}

async function evaluate(
  examples: Example[],
  mode: "diff" | "lexical" | "hybrid",
) {
  let retrievalQueries = 0;
  let retrievalHits = 0;
  let reciprocalRank = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let cleanFalsePositives = 0;
  let eligible = 0;
  let fullyCovered = 0;
  let estimatedInputTokens = 0;
  let actualRequests = 0;
  const statuses = { complete: 0, partial: 0, failed: 0 };
  const started = performance.now();
  for (const example of examples) {
    const result = await runExample(example, mode);
    statuses[result.status]++;
    eligible += result.coverage.eligible;
    fullyCovered += Math.max(
      0,
      result.coverage.reviewed - result.coverage.truncated,
    );
    estimatedInputTokens += result.usage.estimatedInputTokens;
    actualRequests += result.usage.actualRequests;
    const paths = result.context.selected.map((item) => item.path);
    if (example.relevantPaths.length) {
      retrievalQueries++;
      const ranks = example.relevantPaths
        .map((path) => paths.indexOf(path))
        .filter((rank) => rank >= 0);
      if (ranks.length) {
        retrievalHits++;
        reciprocalRank += 1 / (Math.min(...ranks) + 1);
      }
    }
    const actual = new Set(
      result.findings
        .map((finding) => /^eval:(.+)$/.exec(finding.title)?.[1])
        .filter((value): value is string => Boolean(value)),
    );
    const expected = new Set(example.expectedFindings);
    for (const finding of actual) expected.has(finding) ? tp++ : fp++;
    for (const finding of expected) if (!actual.has(finding)) fn++;
    if (example.clean && actual.size) cleanFalsePositives++;
  }
  return {
    retrievalRecallAt3: retrievalQueries
      ? retrievalHits / retrievalQueries
      : null,
    retrievalMRR: retrievalQueries ? reciprocalRank / retrievalQueries : null,
    findingPrecision: tp + fp ? tp / (tp + fp) : null,
    findingRecall: tp + fn ? tp / (tp + fn) : null,
    cleanFalsePositiveRate: examples.some((example) => example.clean)
      ? cleanFalsePositives / examples.filter((example) => example.clean).length
      : null,
    coverage: eligible ? fullyCovered / eligible : 1,
    statuses,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    usage: { estimatedInputTokens, actualRequests },
    counts: { examples: examples.length, tp, fp, fn, retrievalQueries },
  };
}

async function main() {
  const corpus = await loadCorpus();
  const output: Record<string, unknown> = {
    kind: "deterministic-mocked-pipeline-evaluation",
    caveat:
      "Every case runs runReviewPipeline with deterministic mock providers. Metrics validate pipeline plumbing, coverage, evidence, retrieval, status, and usage—not LLM quality.",
  };
  for (const split of ["tuning", "heldout"] as const) {
    const examples = corpus.filter((item) => item.split === split);
    output[split] = Object.fromEntries(
      await Promise.all(
        (["diff", "lexical", "hybrid"] as const).map(async (mode) => [
          mode,
          await evaluate(examples, mode),
        ]),
      ),
    );
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

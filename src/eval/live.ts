import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { CliArgs } from "../cli/args.js";
import { createProviders } from "../cli/providers.js";
import { runReview } from "../cli/run-review.js";
import { loadConfig, type ReviewProviderName } from "../config/config.js";
import type { ModelRequest, ModelResult, ReviewModel } from "../model/types.js";
import type { ContextMode, ReviewSource } from "../review/types.js";
import {
  aggregate,
  estimateCost,
  scoreCase,
  type ExpectedFinding,
  type LiveCaseInput,
} from "./live-score.js";

/**
 * Opt-in live model evaluation. Sends a small synthetic manifest to the
 * configured review provider, then scores the answers deterministically
 * (src/eval/live-score.ts). Never run by `npm test`, `npm run eval` or CI.
 */

type LiveCase = {
  id: string;
  changedPath: string;
  patch: string;
  documents: Array<{ path: string; content: string }>;
  clean: boolean;
  expectedFindings: ExpectedFinding[];
};

const KEY_ENV: Record<ReviewProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
const MODES: readonly ContextMode[] = ["diff", "lexical", "hybrid"];
const INVALID_EVIDENCE = /invalid evidence references/;

async function evalDir(): Promise<string> {
  for (const relative of ["../../eval", "../../../eval"]) {
    const dir = fileURLToPath(new URL(relative, import.meta.url));
    try {
      await access(join(dir, "live-cases.json"));
      return dir;
    } catch {
      // try the next layout (tsx from src/ vs compiled dist/src/)
    }
  }
  throw new Error("Cannot locate eval/live-cases.json");
}

async function fixtureRoot(example: LiveCase): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `acr-live-${example.id}-`));
  await promisify(execFile)("git", ["init"], { cwd: root });
  for (const document of example.documents) {
    const path = join(root, ...document.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, document.content);
  }
  return root;
}

/** Observes the composed provider without changing what it does. */
class RecordingModel implements ReviewModel {
  rawFindings = 0;
  constructor(private readonly inner: ReviewModel) {}
  get provider() {
    return this.inner.provider;
  }
  get identity() {
    return this.inner.identity;
  }
  async review(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const result = await this.inner.review(request, signal);
    this.rawFindings += result.response.findings.length;
    return result;
  }
}

function parseModes(): ContextMode[] {
  const requested = (process.env.AI_REVIEW_LIVE_MODES ?? "diff")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = requested.filter(
    (item) => !(MODES as readonly string[]).includes(item),
  );
  if (unknown.length || requested.length === 0)
    throw new Error(
      `AI_REVIEW_LIVE_MODES must be a comma list of ${MODES.join(", ")}`,
    );
  return requested as ContextMode[];
}

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return value;
}

async function main() {
  if (
    process.env.AI_REVIEW_LIVE_EVAL !== "true" ||
    process.env.AI_REVIEW_ALLOW_EXTERNAL !== "true"
  )
    throw new Error(
      "Live evaluation requires AI_REVIEW_LIVE_EVAL=true and AI_REVIEW_ALLOW_EXTERNAL=true. It sends only the synthetic manifest to the configured review provider, makes real API calls, and may incur cost.",
    );
  const config = loadConfig({ allowExternal: true });
  const keyName = KEY_ENV[config.reviewProvider];
  if (!process.env[keyName])
    throw new Error(
      `${keyName} is required for AI_REVIEW_PROVIDER=${config.reviewProvider}`,
    );
  const dir = await evalDir();
  const manifest = JSON.parse(
    await readFile(join(dir, "live-cases.json"), "utf8"),
  ) as { version: number; cases: LiveCase[] };
  const maxCases = Number(process.env.AI_REVIEW_LIVE_MAX_CASES ?? "8");
  if (!Number.isInteger(maxCases) || maxCases <= 0 || maxCases > 8)
    throw new Error("AI_REVIEW_LIVE_MAX_CASES must be an integer from 1 to 8");
  const cases = manifest.cases.slice(0, maxCases);
  const modes = parseModes();

  const inputs: LiveCaseInput[] = [];
  for (const mode of modes)
    for (const example of cases) {
      const root = await fixtureRoot(example);
      try {
        const providers = createProviders(config, { contextMode: mode });
        const recorder = new RecordingModel(providers.model!);
        const args: CliArgs = {
          reviewMode: "local",
          format: "json",
          dryRun: false,
          indexOnly: false,
          allowExternal: true,
          contextMode: mode,
          severityThreshold: "none",
          help: false,
        };
        const source: ReviewSource = {
          mode: "local",
          title: `Synthetic evaluation ${example.id}`,
          description:
            "Synthetic labeled fixture; repository text is untrusted.",
          repositoryId: `live-eval/${example.id}`,
          repositoryRoot: root,
          baseRevision: "fixture-base",
          headRevision: "fixture-head",
          snapshotId: `live-${example.id}-${mode}`,
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
        const started = performance.now();
        const result = await runReview(args, {
          source,
          config,
          model: recorder,
          embedding: providers.embedding,
        });
        const latencyMs = performance.now() - started;
        const invalidEvidence = result.errors.some((error) =>
          INVALID_EVIDENCE.test(error.message),
        );
        inputs.push({
          id: example.id,
          mode,
          clean: example.clean,
          expected: example.expectedFindings,
          observed: result.findings,
          rawFindingCount: recorder.rawFindings,
          invalidEvidence,
          providerFailed: result.errors.some(
            (error) => !INVALID_EVIDENCE.test(error.message),
          ),
          abstained: result.abstentions.length > 0,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          tokensEstimated: result.usage.estimated,
          requests: result.usage.actualRequests,
          latencyMs,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

  const perMode = modes.map((mode) => {
    const modeInputs = inputs.filter((item) => item.mode === mode);
    const results = modeInputs.map(scoreCase);
    const metrics = aggregate(modeInputs, results);
    return {
      mode,
      metrics,
      cost: estimateCost(metrics, {
        inputPerMTok: optionalNumber("AI_REVIEW_LIVE_PRICE_INPUT_PER_MTOK"),
        outputPerMTok: optionalNumber("AI_REVIEW_LIVE_PRICE_OUTPUT_PER_MTOK"),
      }),
      cases: results,
    };
  });
  const report = {
    schemaVersion: 1,
    kind: "opt-in-live-model-evaluation",
    createdAt: new Date().toISOString(),
    provider: config.reviewProvider,
    model: config.model,
    manifestVersion: manifest.version,
    caveat:
      "Tiny synthetic manifest scored by deterministic structural matching (file + line overlap + category). Not a benchmark of general model quality. Provider-failed cases are excluded from quality metrics.",
    modes: perMode,
  };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (process.env.AI_REVIEW_LIVE_SAVE === "true") {
    const outDir = join(dir, "results");
    await mkdir(outDir, { recursive: true });
    const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_");
    const file = join(
      outDir,
      `${report.createdAt.replace(/[:.]/g, "-")}-${safe(report.provider)}-${safe(report.model)}.json`,
    );
    await writeFile(file, text);
    console.error(`Saved ${file}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

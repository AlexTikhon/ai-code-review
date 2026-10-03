import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { CliArgs } from "../cli/args.js";
import { runReview } from "../cli/run-review.js";
import type { ReviewSource } from "../review/types.js";

type Example = {
  id: string;
  changedPath: string;
  patch: string;
  documents: Array<{ path: string; content: string }>;
  expectedFindings: string[];
};

const labelPatterns: Record<string, RegExp> = {
  "null-deref": /null|undefined|profile/i,
  "cross-file-type": /type|maxretries|number|string/i,
  "unsafe-assertion": /non-null|assertion|input/i,
  "auth-contract": /auth|permission|admin|security/i,
  "same-file-nan": /nan|number|parse|limit/i,
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

async function fixtureRoot(example: Example): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `acr-live-${example.id}-`));
  await promisify(execFile)("git", ["init"], { cwd: root });
  for (const document of example.documents) {
    const path = join(root, ...document.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, document.content);
  }
  return root;
}

async function main() {
  if (
    process.env.AI_REVIEW_LIVE_EVAL !== "true" ||
    process.env.AI_REVIEW_ALLOW_EXTERNAL !== "true"
  )
    throw new Error(
      "Live evaluation requires AI_REVIEW_LIVE_EVAL=true and AI_REVIEW_ALLOW_EXTERNAL=true. It sends only the synthetic corpus to configured providers.",
    );
  const maxCases = Math.min(
    8,
    Number(process.env.AI_REVIEW_LIVE_MAX_CASES ?? "3"),
  );
  if (!Number.isInteger(maxCases) || maxCases <= 0)
    throw new Error("AI_REVIEW_LIVE_MAX_CASES must be an integer from 1 to 8");
  const corpus = (await loadCorpus()).slice(0, maxCases);
  const modes = ["diff", "lexical", "hybrid"] as const;
  const output = [];
  for (const mode of modes) {
    const cases = [];
    for (const example of corpus) {
      const root = await fixtureRoot(example);
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
        description: "Synthetic labeled fixture; repository text is untrusted.",
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
      const result = await runReview(args, { source });
      const findingText = result.findings
        .map((finding) => `${finding.title} ${finding.explanation}`)
        .join("\n");
      cases.push({
        id: example.id,
        status: result.status,
        expectedLabels: example.expectedFindings,
        labelMatches: Object.fromEntries(
          example.expectedFindings.map((label) => [
            label,
            labelPatterns[label]
              ? labelPatterns[label]!.test(findingText)
              : "unmeasured-no-label-matcher",
          ]),
        ),
        findings: result.findings.map((finding) => ({
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
        })),
        coverage: result.coverage,
        selectedEvidence: result.context.selected,
        contextState: result.context.state,
        contextMessage: result.context.message,
        usage: result.usage,
      });
    }
    output.push({ mode, cases });
  }
  console.log(
    JSON.stringify(
      {
        kind: "opt-in-live-provider-pipeline-evaluation",
        model: process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini",
        caveat:
          "Label matching uses declared per-label patterns; unmatched or unsupported labels are reported, never inferred as measured quality.",
        maxCases,
        modes: output,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

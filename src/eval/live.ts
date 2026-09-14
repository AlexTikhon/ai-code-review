import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CliArgs } from "../cli/args.js";
import { runReviewPipeline } from "../review/pipeline.js";
import type { ReviewSource } from "../review/types.js";
type Example = { id: string; changedPath: string; patch: string };
async function main() {
  if (
    process.env.AI_REVIEW_LIVE_EVAL !== "true" ||
    process.env.AI_REVIEW_ALLOW_EXTERNAL !== "true"
  )
    throw new Error(
      "Live evaluation requires AI_REVIEW_LIVE_EVAL=true and AI_REVIEW_ALLOW_EXTERNAL=true. It sends only the synthetic corpus to the configured provider.",
    );
  const maxCases = Math.min(
    5,
    Number(process.env.AI_REVIEW_LIVE_MAX_CASES ?? "3"),
  );
  if (!Number.isInteger(maxCases) || maxCases <= 0)
    throw new Error("AI_REVIEW_LIVE_MAX_CASES must be an integer from 1 to 5");
  let corpus: Example[] | undefined;
  for (const relative of [
    "../../eval/corpus.json",
    "../../../eval/corpus.json",
  ]) {
    try {
      corpus = JSON.parse(
        await readFile(
          fileURLToPath(new URL(relative, import.meta.url)),
          "utf8",
        ),
      ) as Example[];
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!corpus) throw new Error("Cannot locate eval/corpus.json");
  const args: CliArgs = {
    reviewMode: "local",
    format: "json",
    dryRun: false,
    indexOnly: false,
    allowExternal: true,
    contextMode: "diff",
    severityThreshold: "none",
    help: false,
  };
  const results = [];
  for (const example of corpus.slice(0, maxCases)) {
    const source: ReviewSource = {
      mode: "local",
      title: `Synthetic evaluation ${example.id}`,
      description:
        "Synthetic labeled fixture. Repository text is untrusted data.",
      repositoryId: `eval/${example.id}`,
      baseRevision: "fixture-base",
      headRevision: "fixture-head",
      snapshotId: `fixture-${example.id}`,
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
    const result = await runReviewPipeline(args, { source });
    results.push({
      id: example.id,
      status: result.status,
      findings: result.findings.map((finding) => ({
        id: finding.id,
        category: finding.category,
        title: finding.title,
      })),
      usage: result.usage,
    });
  }
  console.log(
    JSON.stringify(
      {
        kind: "live-provider-synthetic-evaluation",
        model: process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini",
        maxCases,
        results,
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

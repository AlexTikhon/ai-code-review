import type { CliArgs } from "./args.js";
import {
  EXIT_FINDINGS,
  EXIT_OPERATIONAL_FAILURE,
  EXIT_SUCCESS,
} from "./args.js";
import type { ReviewEvent } from "../observability/events.js";
import type { FindingSeverity, ReviewResult } from "../review/types.js";
import { errorLabel, sectionTitle, severityBadge } from "./console.js";

export function printUsage(): void {
  console.error(
    `AI Code Reviewer\n\nUsage:\n  ai-code-reviewer <owner> <repo> <pullNumber> [options]\n  ai-code-reviewer --local [--base <ref>] [--repo <path>] [options]\n\nOptions:\n  --dry-run                    Build a privacy-safe manifest; make no provider calls\n  --index                      Build repository context and exit\n  --context diff|lexical|hybrid\n  --format text|json|sarif\n  --severity-threshold high|medium|low|none\n  --allow-external             Also requires AI_REVIEW_ALLOW_EXTERNAL=true\n  --help`,
  );
}
export function stderrEvent(event: ReviewEvent): void {
  const detail = event.filename
    ? ` ${event.filename}`
    : event.message
      ? ` ${event.message}`
      : "";
  console.error(`[${event.stage}] ${event.type}${detail}`);
}
function sarif(result: ReviewResult) {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "ai-code-reviewer",
            version: result.schemaVersion,
            rules: [
              ...new Set(result.findings.map((finding) => finding.category)),
            ].map((id) => ({ id, name: id })),
          },
        },
        invocations: [
          {
            executionSuccessful: result.status === "complete",
            properties: {
              status: result.status,
              coverage: result.coverage,
              usage: result.usage,
              runId: result.runId,
              context: result.context.state,
              abstentions: result.abstentions,
            },
            toolExecutionNotifications: result.errors.map((error) => ({
              level: error.fatal ? "error" : "warning",
              message: { text: `${error.stage}: ${error.message}` },
            })),
          },
        ],
        results: result.findings.map((finding) => ({
          ruleId: finding.category,
          level:
            finding.severity === "high"
              ? "error"
              : finding.severity === "medium"
                ? "warning"
                : "note",
          message: { text: `${finding.title}: ${finding.explanation}` },
          partialFingerprints: { stableId: finding.id },
          properties: {
            confidence: finding.confidence,
            evidence: finding.evidence,
          },
          locations: finding.evidence.slice(0, 1).map((evidence) => ({
            physicalLocation: {
              artifactLocation: { uri: evidence.path },
              region: {
                startLine: evidence.startLine,
                endLine: evidence.endLine,
              },
            },
          })),
        })),
      },
    ],
  };
}
export function printReviewResult(
  result: ReviewResult,
  format: CliArgs["format"],
): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "sarif") {
    console.log(JSON.stringify(sarif(result), null, 2));
    return;
  }
  console.log(`\n${sectionTitle("SUMMARY")}\n${result.summary}`);
  console.log(`Status: ${result.status}`);
  console.log(
    `Coverage: discovered=${result.coverage.discovered}, eligible=${result.coverage.eligible}, attempted=${result.coverage.attempted}, reviewed=${result.coverage.reviewed}, failed=${result.coverage.failed}, skipped=${result.coverage.skipped}, truncated=${result.coverage.truncated}`,
  );
  if (result.abstentions.length)
    console.log(`Abstentions: ${result.abstentions.length}`);
  if (result.dryRun)
    console.log(
      `\n${sectionTitle("DRY-RUN MANIFEST")}\n${JSON.stringify(result.dryRun, null, 2)}`,
    );
  if (result.errors.length) {
    console.error(`\n${sectionTitle("ERRORS")}`);
    for (const error of result.errors)
      console.error(
        `${errorLabel("*")} ${error.stage}${error.filename ? `/${error.filename}` : ""}: ${error.message}`,
      );
  }
  console.log(`\n${sectionTitle("FINDINGS")}`);
  if (!result.findings.length)
    console.log(
      "None (this is a clean result only when status=complete and reviewed>0). ",
    );
  for (const [index, finding] of result.findings.entries()) {
    console.log(
      `${index + 1}. [${severityBadge(finding.severity)}] ${finding.filename}:${finding.evidence[0]?.startLine ?? "?"} ${finding.title} (${finding.category}, confidence=${finding.confidence}, id=${finding.id})`,
    );
    console.log(`   ${finding.explanation}`);
    if (finding.suggestion) console.log(`   Suggestion: ${finding.suggestion}`);
  }
}
const ranks: Record<FindingSeverity, number> = { low: 1, medium: 2, high: 3 };
export function resultExitCode(
  result: ReviewResult,
  threshold: CliArgs["severityThreshold"],
): number {
  if (result.status !== "complete") return EXIT_OPERATIONAL_FAILURE;
  if (
    threshold !== "none" &&
    result.findings.some(
      (finding) => ranks[finding.severity] >= ranks[threshold],
    )
  )
    return EXIT_FINDINGS;
  return EXIT_SUCCESS;
}

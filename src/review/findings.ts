import { createHash } from "node:crypto";
import type { ContextChunk } from "../retrieval/types.js";
import type { ReviewResponse } from "../schemas/review.schema.js";
import type { PatchSegment, ReviewerFinding } from "./types.js";
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function validateFindings(
  response: ReviewResponse,
  filename: string,
  segment: PatchSegment,
  contexts: ContextChunk[],
): ReviewerFinding[] {
  const changed = new Set<number>();
  for (const range of segment.lineRanges)
    for (let line = range.start; line <= range.end; line++) changed.add(line);
  const contextById = new Map(contexts.map((chunk) => [chunk.id, chunk]));
  const findings: ReviewerFinding[] = [];
  for (const raw of response.findings) {
    let valid = true;
    const evidence = raw.evidence.map((item) => {
      if (item.contextId) {
        const context = contextById.get(item.contextId);
        if (
          !context ||
          context.path !== item.path ||
          item.startLine < context.startLine ||
          item.endLine > context.endLine
        )
          valid = false;
      } else if (
        item.path !== filename ||
        !changed.has(item.startLine) ||
        !changed.has(item.endLine)
      )
        valid = false;
      return {
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        contextId: item.contextId ?? undefined,
        excerptHash: hash(
          `${item.path}:${item.startLine}:${item.endLine}:${item.contextId ?? segment.id}`,
        ).slice(0, 16),
      };
    });
    if (!valid) continue;
    const canonical = `${filename}\0${raw.category}\0${raw.title.toLowerCase().replace(/\W+/g, " ").trim()}\0${evidence.map((e) => `${e.path}:${e.startLine}:${e.endLine}`).join("|")}`;
    findings.push({
      id: `acr-${hash(canonical).slice(0, 16)}`,
      filename,
      severity: raw.severity,
      category: raw.category,
      confidence: raw.confidence,
      title: raw.title,
      explanation: raw.explanation,
      evidence,
      suggestion: raw.suggestion ?? undefined,
    });
  }
  return deduplicateFindings(findings);
}
export function deduplicateFindings(
  findings: ReviewerFinding[],
): ReviewerFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.filename}|${finding.category}|${finding.title.toLowerCase().replace(/\W+/g, " ").trim()}|${finding.evidence.map((e) => `${e.path}:${e.startLine}:${e.endLine}`).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

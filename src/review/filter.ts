import ignore from "ignore";
import type { ReviewConfig } from "../config/config.js";
import { evaluateFilePrivacy } from "../privacy/policy.js";
import { classifyFile, isReviewableFileType } from "./file-classifier.js";
import { isIgnoredPath, type LoadedIgnore } from "./ignore.js";
import { planReviewSegments } from "./request-plan.js";
import type { ReviewSource, ReviewableFile, SkippedFile } from "./types.js";
export function ignoreFromTrustedContents(contents?: string): LoadedIgnore {
  return {
    path: "trusted-base:.ai-reviewer-ignore",
    rules: [],
    matcher: ignore().add(contents ?? ""),
  };
}
export function filterReviewFiles(
  source: ReviewSource,
  policy: LoadedIgnore,
  config: ReviewConfig,
): {
  files: ReviewableFile[];
  skipped: SkippedFile[];
  eligible: number;
  omitted: number;
} {
  const files: ReviewableFile[] = [];
  const skipped: SkippedFile[] = [];
  let eligible = 0;
  let omitted = 0;
  for (const sourceFile of source.files) {
    const fileType = classifyFile(sourceFile.filename);
    const privacy = evaluateFilePrivacy(sourceFile);
    if (!privacy.allowed) {
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: privacy.reason!,
        details: privacy.details,
      });
      continue;
    }
    if (isIgnoredPath(sourceFile.filename, policy)) {
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "ignored_by_user",
        details: `Matched ${policy.path}.`,
      });
      continue;
    }
    if (fileType === "generated") {
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "generated_file",
        details: "Generated artifact or snapshot.",
      });
      continue;
    }
    if (!isReviewableFileType(fileType)) {
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "unsupported_file_type",
        details: `File classified as ${fileType}.`,
      });
      continue;
    }
    eligible++;
    if (!sourceFile.patch) {
      omitted++;
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "missing_patch",
        details:
          "No textual patch is available for this otherwise reviewable file.",
      });
      continue;
    }
    if (files.length >= config.maxFiles) {
      omitted++;
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "work_limit",
        details: `Exceeded max file count ${config.maxFiles}.`,
      });
      continue;
    }
    const plan = planReviewSegments(
      sourceFile.patch,
      {
        title: source.title,
        description: source.description,
        filename: sourceFile.filename,
        fileType,
      },
      config,
    );
    if (plan.unplannable) {
      omitted++;
      skipped.push({
        filename: sourceFile.filename,
        fileType,
        reason: "work_limit",
        details: plan.unplannable,
      });
      continue;
    }
    const { segments } = plan;
    files.push({
      ...sourceFile,
      fileType,
      segments,
      truncated:
        plan.truncated || segments.some((segment) => segment.truncated),
      originalPatchCharacters: sourceFile.patch.length,
    });
  }
  return { files, skipped, eligible, omitted };
}

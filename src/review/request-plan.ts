import type { ReviewConfig } from "../config/config.js";
import {
  MIN_DIFF_HEADROOM_TOKENS,
  estimatePromptTokens,
} from "../prompts/estimate.js";
import {
  REVIEW_SYSTEM_PROMPT,
  estimateMandatoryRequestTokens,
  renderMandatoryRequest,
  renderReviewMetadata,
  renderReviewUser,
} from "../prompts/review.js";
import { patchCapFits, planPatchSegments, type PatchPlan } from "./patch.js";
import type { PatchSegment, ReviewedFileType } from "./types.js";

/**
 * Deterministic, provider-neutral request planning. One definition of "how big
 * is this request" serves segmentation, filtering, dry-run and execution:
 *
 *   usable input   = maxInputTokens - maxOutputTokens
 *   mandatory      = system + metadata + framing + schema + diff segment
 *                    + line map + valid ranges      (estimatePromptTokens)
 *   context room   = min(maxContextTokens, usable - mandatory)
 *
 * Estimates are conservative application-level figures (UTF-8 bytes plus the
 * shared schema and framing allowance), not provider billing-token counts.
 * This module reads nothing, calls nothing and knows no provider.
 */
export type RequestBudget = Pick<
  ReviewConfig,
  | "maxInputTokens"
  | "maxOutputTokens"
  | "maxMetadataCharacters"
  | "maxPatchTokens"
  | "maxContextTokens"
  | "maxSegmentsPerFile"
>;

/** What the prompt says about the change, shared by every file's requests. */
export type RequestSubject = { title: string; description: string };

export type FileRequestInput = RequestSubject & {
  filename: string;
  fileType: ReviewedFileType;
};

export function usableInputTokens(
  budget: Pick<RequestBudget, "maxInputTokens" | "maxOutputTokens">,
): number {
  return budget.maxInputTokens - budget.maxOutputTokens;
}

const metadataFor = (file: FileRequestInput, budget: RequestBudget) =>
  renderReviewMetadata({
    title: file.title,
    description: file.description,
    filename: file.filename,
    fileType: file.fileType,
    maxMetadataCharacters: budget.maxMetadataCharacters,
  });

/** Mandatory (diff-only) input estimate for one segment of one file. */
export function estimateSegmentRequest(
  file: FileRequestInput,
  segment: PatchSegment,
  budget: RequestBudget,
): number {
  return estimateMandatoryRequestTokens(metadataFor(file, budget), segment);
}

/**
 * Most optional context this segment's request can carry: the independent
 * context cap, further limited by what the mandatory request leaves free.
 */
export function contextAllowanceTokens(
  mandatoryTokens: number,
  budget: RequestBudget,
): number {
  return Math.max(
    0,
    Math.min(
      budget.maxContextTokens,
      usableInputTokens(budget) - mandatoryTokens,
    ),
  );
}

export type SegmentPlan = PatchPlan & {
  /** Set when nothing could be planned: why no content fits a request. */
  unplannable?: string;
};

/**
 * Segment one file's patch so that every segment's full mandatory request
 * fits the usable input allowance and its text fits the independent patch cap.
 * The same renderers assembleReviewPrompt uses build each candidate, so a
 * planned segment cannot be rejected later for ordinary density.
 */
export function planReviewSegments(
  patch: string,
  file: FileRequestInput,
  budget: RequestBudget,
): SegmentPlan {
  const metadata = metadataFor(file, budget);
  const usable = usableInputTokens(budget);
  const plan = planPatchSegments(
    patch,
    budget.maxSegmentsPerFile,
    (candidate) =>
      patchCapFits(candidate, budget.maxPatchTokens) &&
      estimateMandatoryRequestTokens(metadata, candidate) <= usable,
  );
  if (plan.segments.length) return plan;
  const fixed = estimateMandatoryRequestTokens(metadata, EMPTY_SEGMENT);
  return {
    ...plan,
    unplannable: `Mandatory request content (about ${fixed} of ${usable} usable input tokens, including metadata and the path) leaves no room for any diff content.`,
  };
}

const EMPTY_SEGMENT: PatchSegment = {
  id: "0".repeat(16),
  text: "",
  lineRanges: [],
  lineMappings: [],
  truncated: false,
};

/**
 * Reject impossible budget combinations before any provider or context work.
 * Returns an actionable message, or undefined when the budget is workable.
 */
export function requestBudgetProblem(
  budget: Pick<RequestBudget, "maxInputTokens" | "maxOutputTokens">,
): string | undefined {
  if (budget.maxOutputTokens >= budget.maxInputTokens)
    return `AI_REVIEW_MAX_OUTPUT_TOKENS (${budget.maxOutputTokens}) must be smaller than AI_REVIEW_MAX_INPUT_TOKENS (${budget.maxInputTokens}); the output reservation is taken out of the input allowance.`;
  const usable = usableInputTokens(budget);
  const fixed = estimatePromptTokens({
    system: REVIEW_SYSTEM_PROMPT,
    user: renderReviewUser(
      renderMandatoryRequest(
        renderReviewMetadata({
          title: "",
          description: "",
          filename: "",
          fileType: "unknown",
          maxMetadataCharacters: 0,
        }),
        EMPTY_SEGMENT,
      ),
      "",
      EMPTY_SEGMENT,
    ),
  });
  if (usable <= fixed + MIN_DIFF_HEADROOM_TOKENS)
    return `The usable input allowance (AI_REVIEW_MAX_INPUT_TOKENS ${budget.maxInputTokens} - AI_REVIEW_MAX_OUTPUT_TOKENS ${budget.maxOutputTokens} = ${usable}) must exceed the fixed prompt, response schema and framing (${fixed}) by more than ${MIN_DIFF_HEADROOM_TOKENS} tokens to leave room for a diff.`;
  return undefined;
}

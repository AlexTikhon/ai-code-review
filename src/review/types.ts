import type { ModelErrorCode } from "../model/errors.js";
import type { EmbeddingErrorCode } from "../retrieval/embedding-errors.js";

export const RESULT_SCHEMA_VERSION = "1.2.0";
export const PROMPT_VERSION = "3.0.0";
export const POLICY_VERSION = "1.1.0";

export type ReviewStatus = "complete" | "partial" | "failed";
export type ContextMode = "diff" | "lexical" | "hybrid";
export type FindingSeverity = "high" | "medium" | "low";
export type FindingCategory =
  | "correctness"
  | "security"
  | "performance"
  | "type-safety"
  | "error-handling"
  | "maintainability";
export type FindingConfidence = "low" | "medium" | "high";

export type EvidenceReference = {
  path: string;
  startLine: number;
  endLine: number;
  contextId?: string;
  excerptHash?: string;
};
export type ReviewerFinding = {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  confidence: FindingConfidence;
  filename: string;
  title: string;
  explanation: string;
  evidence: EvidenceReference[];
  suggestion?: string;
};

export type ReviewedFileType =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "lockfile"
  | "generated"
  | "binary"
  | "unknown";
export type SkippedFileReason =
  | "missing_patch"
  | "unsupported_file_type"
  | "generated_file"
  | "ignored_by_user"
  | "sensitive_path"
  | "sensitive_content"
  | "symlink"
  | "work_limit";
export type SourceFile = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};
export type ReviewSource = {
  mode: "pr" | "local";
  title: string;
  description: string;
  repositoryId: string;
  repositoryRoot?: string;
  baseRevision: string;
  headRevision: string;
  snapshotId: string;
  files: SourceFile[];
  coverageComplete: boolean;
  coverageError?: string;
  trustedIgnoreContents?: string;
};
export type PatchSegment = {
  id: string;
  text: string;
  lineRanges: Array<{ start: number; end: number }>;
  lineMappings: Array<{
    segmentLine: number;
    kind: "context" | "addition" | "deletion";
    oldLine?: number;
    newLine?: number;
    complete: boolean;
  }>;
  truncated: boolean;
};
export type ReviewableFile = SourceFile & {
  fileType: ReviewedFileType;
  segments: PatchSegment[];
  truncated: boolean;
  originalPatchCharacters: number;
};
export type SkippedFile = {
  filename: string;
  fileType: ReviewedFileType;
  reason: SkippedFileReason;
  details?: string;
};

export type Coverage = {
  /** Source entries reported by Git/GitHub. */ discovered: number;
  /** Reviewable source/test/config entries, including entries omitted for missing coverage or work limits. */ eligible: number;
  /** Files for which a review was scheduled; cache hits count. */ attempted: number;
  /** Files whose scheduled segments all returned a valid review or abstention. */ reviewed: number;
  /** Eligible files with an operational/model/validation failure. */ failed: number;
  /** Entries intentionally excluded by privacy, ignore, generated-file, or file-type policy. */ skipped: number;
  /** Eligible entries omitted because a patch was unavailable or a work limit was reached. */ omitted: number;
  /** Eligible files whose original diff was not fully presented. */ truncated: number;
};
export type Usage = {
  /** Logical diff segments processed or served from cache. */
  requests: number;
  /** Actual model provider attempts in this run, including retries. */
  attempts: number;
  /** Actual provider-reported model tokens for this run only. */
  inputTokens: number;
  outputTokens: number;
  /** All external model and embedding calls made in this run. */
  actualRequests: number;
  /** Actual embedding calls made in this run. */
  embeddingRequests: number;
  /** Conservative input estimate for logical review work, including cache hits. */
  estimatedInputTokens: number;
  estimated: boolean;
  cacheHits: number;
  latencyMs: number;
};
/**
 * Stable, machine-readable reason for a failure during analysis. Consumers
 * should branch on this, never on `message`.
 */
export type ReviewErrorCode =
  | ModelErrorCode
  /** The embedding provider failed; distinct from MODEL_* for the review model. */
  | EmbeddingErrorCode
  /** The model answered, but a finding cited evidence that was not supplied. */
  | "MODEL_INVALID_EVIDENCE"
  | "REQUEST_BUDGET_EXHAUSTED"
  /** Cancelled by the total deadline or the caller. */
  | "REVIEW_ABORTED"
  /** Any other analysis failure, e.g. a prompt that cannot fit its budget. */
  | "ANALYSIS_FAILED";
export type ReviewError = {
  stage:
    | "config"
    | "ingest"
    | "filter"
    | "index"
    | "retrieve"
    | "analyze"
    | "finalize";
  message: string;
  filename?: string;
  fatal: boolean;
  code?: ReviewErrorCode;
  /** Model provider involved, for model failures. */
  provider?: string;
  /** Whether re-running the review could plausibly succeed. */
  retryable?: boolean;
};
export type ContextUse = {
  id: string;
  path: string;
  score: number;
  reasons: string[];
  startLine: number;
  endLine: number;
};
export type ReviewResult = {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  runId: string;
  status: ReviewStatus;
  summary: string;
  source?: Omit<ReviewSource, "files" | "trustedIgnoreContents">;
  coverage: Coverage;
  findings: ReviewerFinding[];
  abstentions: Array<{ filename: string; segmentId: string; reason: string }>;
  skippedFiles: SkippedFile[];
  errors: ReviewError[];
  usage: Usage;
  context: {
    mode: ContextMode;
    state: "used" | "unavailable" | "stale" | "disabled";
    selected: ContextUse[];
    message?: string;
  };
  model: { provider: string; name: string; promptVersion: string };
  policyVersion: string;
  dryRun?: {
    proposedFiles: Array<{
      filename: string;
      segments: number;
      estimatedInputTokens: number;
    }>;
    omissions: SkippedFile[];
    destinations: string[];
    estimatedRequests: number;
    estimatedInputTokens: number;
  };
};

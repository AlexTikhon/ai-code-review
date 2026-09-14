export const RESULT_SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "2.0.0";
export const POLICY_VERSION = "1.0.0";

export type ReviewStatus = "complete" | "partial" | "failed";
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
  /** Entries permitted by mandatory privacy policy, user ignore rules, and type policy. */ eligible: number;
  /** Files for which a review was scheduled; cache hits count. */ attempted: number;
  /** Files whose scheduled segments all returned a valid review or abstention. */ reviewed: number;
  /** Eligible files with an operational/model/validation failure. */ failed: number;
  /** Entries intentionally omitted by policy or unsupported type. */ skipped: number;
  /** Eligible files whose original diff was not fully presented. */ truncated: number;
};
export type Usage = {
  requests: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  actualRequests: number;
  estimated: boolean;
  cacheHits: number;
  latencyMs: number;
};
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
    mode: "diff" | "lexical" | "hybrid";
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
export type FilteredFile = ReviewableFile;

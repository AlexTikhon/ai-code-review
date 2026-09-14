/** Source-neutral domain state replaced the former framework-specific annotation. */
export type {
  ReviewResult as ReviewerState,
  ReviewableFile as FilteredFile,
  ReviewedFileType,
  ReviewerFinding,
  SkippedFile,
  SkippedFileReason,
} from "../review/types.js";

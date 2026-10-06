import { createHash } from "node:crypto";
import type { ReviewSource } from "./types.js";

/**
 * Which local bytes a repository-context index was built from.
 *
 * This is deliberately not the review source's identity. A pull request's
 * `owner/repo` says where a change came from (and may be a fork); the context
 * index describes the local checkout whose files and Git objects were read.
 * The same checkout reviewed as `--local` or as any pull request is therefore
 * one index, while two checkouts of the same GitHub repository are two.
 */
export type RepositoryContextIdentity = {
  /** Derived from the canonical checkout root only; never a remote URL. */
  localRepositoryId: string;
};

/**
 * Identity of one checkout (the work tree's real path). A linked Git worktree
 * shares its object database with the main work tree but not its files, and a
 * local index reads files, so each worktree is its own checkout and index.
 */
export function localRepositoryId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot.toLowerCase()).digest("hex");
}

export function localContextIdentity(
  canonicalRoot: string,
): RepositoryContextIdentity {
  return { localRepositoryId: localRepositoryId(canonicalRoot) };
}

/**
 * The identity the persisted index and retrieval must agree on. Sources that
 * carry no local checkout identity (synthetic evaluation sources) use their own.
 */
export function contextRepositoryId(
  source: Pick<ReviewSource, "repositoryId" | "contextIdentity">,
): string {
  return source.contextIdentity?.localRepositoryId ?? source.repositoryId;
}

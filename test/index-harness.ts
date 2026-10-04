import { execFile } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DeterministicTestEmbedding,
  type EmbeddingAdapter,
} from "../src/retrieval/embeddings.js";
import type { RepositoryIndexInput } from "../src/retrieval/index-store.js";
import { loadIgnorePolicy } from "../src/review/ignore.js";

const run = promisify(execFile);
const delegate = new DeterministicTestEmbedding();
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

/** A throwaway git repository holding `files`, with old mtimes. */
export async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acr-ckpt-"));
  await run("git", ["init"], { cwd: root });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "T"], { cwd: root });
  for (const [path, content] of Object.entries(files))
    await put(root, path, content);
  return root;
}

export async function put(root: string, path: string, content: string) {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
  await utimes(full, LONG_AGO, LONG_AGO);
}

export const sources = (count: number, from = 0) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `src/m${from + i}.ts`,
      `export function work${from + i}() { return ${from + i}; }\n`,
    ]),
  );

export type EmbeddingProbe = {
  /** Provider calls actually made. */
  requests: number;
  /** Texts embedded across those calls. */
  texts: number;
  /** Throw on this (1-based) request number. */
  failAt?: number;
  /** Runs after each completed request, with its 1-based number. */
  afterRequest?: (request: number) => void;
};

/**
 * A deterministic embedding provider that counts calls and can be told to
 * fail on a chosen request: the fault-injection seam for resumable indexing.
 */
export function probedEmbedding(
  identity: Partial<
    Pick<EmbeddingAdapter, "provider" | "model" | "version" | "dimensions">
  > & { dimensions?: number | undefined } = {},
) {
  const state: EmbeddingProbe = { requests: 0, texts: 0 };
  const adapter: EmbeddingAdapter = {
    provider: identity.provider ?? delegate.provider,
    model: identity.model ?? delegate.model,
    version: identity.version ?? delegate.version,
    dimensions:
      "dimensions" in identity ? identity.dimensions : delegate.dimensions,
    async embed(texts: string[]) {
      const number = ++state.requests;
      if (state.failAt === number) throw new Error("provider down");
      state.texts += texts.length;
      const vectors = await delegate.embed(texts);
      state.afterRequest?.(number);
      return vectors;
    },
  };
  return { state, adapter };
}

export async function indexOptions(
  root: string,
  extra: Partial<RepositoryIndexInput> = {},
): Promise<RepositoryIndexInput> {
  return {
    root,
    repositoryId: "repo",
    revision: "rev-1",
    cacheDirName: ".cache",
    maxChunkTokens: 100,
    ignorePolicy: await loadIgnorePolicy(root),
    ...extra,
  };
}

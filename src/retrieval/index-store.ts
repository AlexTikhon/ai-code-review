import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertContainedRegularFile,
  inspectSensitiveContent,
  isMandatorySensitivePath,
} from "../privacy/policy.js";
import { isIgnoredPath, type LoadedIgnore } from "../review/ignore.js";
import {
  CHUNKER_VERSION,
  type RepositoryIndex,
  type StoredVector,
} from "./types.js";
import { chunkSource } from "./chunker.js";
import type { EmbeddingAdapter } from "./embeddings.js";
const execFileAsync = promisify(execFile);
const INDEXABLE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|cpp|cc|c|h|hpp|php)$/i;
export function indexPath(root: string, cacheDirName: string): string {
  return join(root, cacheDirName, "repository-index.json");
}
export async function loadIndex(
  path: string,
): Promise<RepositoryIndex | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RepositoryIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function trackedNames(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean);
}
export async function buildRepositoryIndex(input: {
  root: string;
  repositoryId: string;
  revision: string;
  cacheDirName: string;
  maxChunkTokens: number;
  ignorePolicy: LoadedIgnore;
  embedding?: EmbeddingAdapter;
  signal?: AbortSignal;
}): Promise<RepositoryIndex> {
  const path = indexPath(input.root, input.cacheDirName);
  const old = await loadIndex(path);
  const chunks = [];
  for (const name of await trackedNames(input.root)) {
    if (
      !INDEXABLE.test(name) ||
      isMandatorySensitivePath(name) ||
      isIgnoredPath(name, input.ignorePolicy)
    )
      continue;
    try {
      const size = await assertContainedRegularFile(input.root, name);
      if (size > 1024 * 1024) continue;
      const content = await readFile(resolve(input.root, name), "utf8");
      if (inspectSensitiveContent(content)) continue;
      chunks.push(
        ...chunkSource({
          repositoryId: input.repositoryId,
          revision: input.revision,
          path: name.replaceAll("\\", "/"),
          content,
          maxTokens: input.maxChunkTokens,
        }),
      );
    } catch {
      /* unreadable/binary/symlink entries are unavailable to retrieval */
    }
  }
  const vectors: Record<string, StoredVector> = {};
  if (input.embedding) {
    const missing = [];
    for (const chunk of chunks) {
      const cacheKey = `${chunk.contentHash}:${input.embedding.model}:${input.embedding.version}:${CHUNKER_VERSION}`;
      const cached = old?.vectors[cacheKey];
      if (cached) vectors[cacheKey] = cached;
      else missing.push({ chunk, cacheKey });
    }
    for (let offset = 0; offset < missing.length; offset += 32) {
      const batch = missing.slice(offset, offset + 32);
      const embedded = await input.embedding.embed(
        batch.map(
          ({ chunk }) =>
            `${chunk.path}\n${chunk.signature ?? ""}\n${chunk.content}`,
        ),
        input.signal,
      );
      batch.forEach((item, index) => {
        vectors[item.cacheKey] = {
          cacheKey: item.cacheKey,
          values: embedded[index]!,
        };
      });
    }
  }
  const index: RepositoryIndex = {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: input.repositoryId,
    revision: input.revision,
    createdAt: new Date().toISOString(),
    chunks,
    vectors,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(index), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return index;
}

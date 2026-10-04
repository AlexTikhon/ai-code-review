import type { ContextChunk, IndexedFile } from "../src/retrieval/types.js";

/** File entries consistent with a hand-built chunk list (one per path, in order). */
export function filesForChunks(chunks: readonly ContextChunk[]): IndexedFile[] {
  const files = new Map<string, IndexedFile>();
  for (const chunk of chunks) {
    const file = files.get(chunk.path);
    if (file) file.chunkIds.push(chunk.id);
    else
      files.set(chunk.path, {
        path: chunk.path,
        contentHash: `fixture-${chunk.path}`,
        size: 0,
        chunkIds: [chunk.id],
      });
  }
  return [...files.values()];
}

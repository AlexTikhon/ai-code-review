import assert from "node:assert/strict";
import { chunkSource } from "../src/retrieval/chunker.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import {
  embeddingCacheKey,
  embeddingInputHash,
} from "../src/retrieval/index-store.js";
import {
  findStoredVector,
  prepareRepositoryIndex,
} from "../src/retrieval/prepared-index.js";
import { retrieveContext } from "../src/retrieval/retrieve.js";
import {
  CHUNKER_VERSION,
  type ContextChunk,
  type RepositoryIndex,
  type RetrievalCandidate,
  type StoredVector,
} from "../src/retrieval/types.js";
import { unitTest } from "./helpers.js";

const embedding = new DeterministicTestEmbedding();
const WORDS = [
  "user",
  "profile",
  "account",
  "retry",
  "limit",
  "parse",
  "token",
  "render",
  "queue",
  "cache",
  "admin",
  "order",
];

async function buildIndex(
  files: number,
  withVectors = true,
): Promise<RepositoryIndex> {
  const chunks: ContextChunk[] = [];
  for (let i = 0; i < files; i++) {
    const a = WORDS[i % WORDS.length]!;
    const b = WORDS[(i * 5 + 3) % WORDS.length]!;
    chunks.push(
      ...chunkSource({
        repositoryId: "r",
        revision: "v",
        path: `src/m${i}/${a}.ts`,
        content: `import { ${b}Helper } from "./${b}";\nexport function ${a}${i}(input: string) {\n  return ${b}Helper(input) + "${a} ${b}";\n}\n`,
        maxTokens: 200,
      }),
    );
  }
  const vectors: RepositoryIndex["vectors"] = {};
  if (withVectors)
    for (const chunk of chunks) {
      const key = embeddingCacheKey(chunk, embedding, 200);
      vectors[key] = {
        cacheKey: key,
        values: (await embedding.embed([chunk.content]))[0]!,
        inputHash: embeddingInputHash(chunk),
        dimensions: 64,
        provider: embedding.provider,
        model: embedding.model,
        version: embedding.version,
        dimensionIdentity: "64",
        chunkerVersion: CHUNKER_VERSION,
        maxChunkTokens: 200,
      };
    }
  return {
    schemaVersion: 1,
    chunkerVersion: CHUNKER_VERSION,
    repositoryId: "r",
    revision: "v",
    maxChunkTokens: 200,
    createdAt: "now",
    chunks,
    vectors,
  };
}

/**
 * Reference implementation: the pre-refactor algorithm, kept verbatim in spirit
 * (re-tokenize every chunk per query; linear scan of all vectors per chunk).
 */
async function referenceRetrieve(
  index: RepositoryIndex,
  query: string,
  changedPath: string,
  mode: "lexical" | "hybrid",
  candidates: number,
  topK: number,
  threshold: number,
): Promise<RetrievalCandidate[]> {
  const tokens = (value: string) =>
    new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);
  const queryTokens = tokens(query);
  const lexical = index.chunks
    .map((chunk) => {
      const haystack = tokens(
        `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
      );
      let overlap = 0;
      for (const token of queryTokens) if (haystack.has(token)) overlap++;
      const importBoost = chunk.imports.some((item) =>
        changedPath.includes(item.replace(/^\.\//, "")),
      )
        ? 0.2
        : 0;
      const symbolBoost =
        chunk.name && queryTokens.has(chunk.name.toLowerCase()) ? 0.35 : 0;
      const sameFileBoost = chunk.path === changedPath ? 0.05 : 0;
      const score = Math.min(
        1,
        (queryTokens.size ? overlap / queryTokens.size : 0) +
          importBoost +
          symbolBoost +
          sameFileBoost,
      );
      const reasons = [
        overlap ? `keyword-overlap:${overlap}` : "",
        importBoost ? "import-link" : "",
        symbolBoost ? "symbol-match" : "",
        sameFileBoost ? "same-file" : "",
      ].filter(Boolean);
      return { chunk, score, reasons } as RetrievalCandidate;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, candidates);
  const semantic: RetrievalCandidate[] = [];
  if (mode === "hybrid") {
    const queryVector = (await embedding.embed([query]))[0]!;
    for (const chunk of index.chunks) {
      const hash = embeddingInputHash(chunk);
      const stored = Object.values(index.vectors).find(
        (vector: StoredVector) =>
          vector.inputHash === hash &&
          vector.provider === embedding.provider &&
          vector.model === embedding.model &&
          vector.version === embedding.version &&
          vector.dimensionIdentity === String(embedding.dimensions) &&
          vector.chunkerVersion === index.chunkerVersion &&
          vector.maxChunkTokens === index.maxChunkTokens,
      );
      if (!stored) continue;
      let dot = 0;
      let aa = 0;
      let bb = 0;
      for (let i = 0; i < queryVector.length; i++) {
        dot += queryVector[i]! * stored.values[i]!;
        aa += queryVector[i]! ** 2;
        bb += stored.values[i]! ** 2;
      }
      const score = Math.max(0, aa && bb ? dot / Math.sqrt(aa * bb) : 0);
      semantic.push({
        chunk,
        score,
        reasons: [`semantic:${score.toFixed(3)}`],
      });
    }
    semantic.sort((a, b) => b.score - a.score).splice(candidates);
  }
  const union = new Map<
    string,
    {
      chunk: ContextChunk;
      lexical: number;
      semantic: number;
      reasons: string[];
    }
  >();
  for (const c of lexical)
    union.set(c.chunk.id, {
      chunk: c.chunk,
      lexical: c.score,
      semantic: 0,
      reasons: [...c.reasons],
    });
  for (const c of semantic) {
    const existing = union.get(c.chunk.id);
    if (existing) {
      existing.semantic = c.score;
      existing.reasons.push(...c.reasons);
    } else
      union.set(c.chunk.id, {
        chunk: c.chunk,
        lexical: 0,
        semantic: c.score,
        reasons: [...c.reasons],
      });
  }
  const ranked = [...union.values()]
    .map((u) => ({
      chunk: u.chunk,
      score: mode === "hybrid" ? u.lexical * 0.4 + u.semantic * 0.6 : u.lexical,
      reasons: u.reasons,
    }))
    .sort((a, b) => b.score - a.score);
  const deduped = new Map<string, RetrievalCandidate>();
  for (const c of ranked)
    if (c.score >= threshold && !deduped.has(c.chunk.contentHash))
      deduped.set(c.chunk.contentHash, c);
  return [...deduped.values()].slice(0, topK);
}

const queries: Array<[string, string]> = [
  ["src/app.ts", "src/app.ts\nuser profile helper input retry"],
  ["src/m3/token.ts", "src/m3/token.ts\nparse limit queue cache render"],
  ["src/zz.ts", "src/zz.ts\nadmin order account userHelper"],
  ["src/m0/user.ts", "unrelatedwordsonly nothing matches here"],
];

unitTest(
  "prepared retrieval ranks exactly like the original algorithm",
  async () => {
    const index = await buildIndex(40);
    const prepared = prepareRepositoryIndex(index);
    for (const mode of ["lexical", "hybrid"] as const)
      for (const [changedPath, query] of queries) {
        const expected = await referenceRetrieve(
          index,
          query,
          changedPath,
          mode,
          10,
          5,
          0,
        );
        const input = {
          repositoryId: "r",
          revision: "v",
          query,
          changedPath,
          mode,
          candidates: 10,
          topK: 5,
          threshold: 0,
          embedding: mode === "hybrid" ? embedding : undefined,
        };
        const viaPrepared = await retrieveContext({
          ...input,
          index: prepared,
        });
        const viaRaw = await retrieveContext({ ...input, index });
        assert.deepEqual(viaPrepared, expected, `${mode} ${changedPath}`);
        assert.deepEqual(viaRaw, expected, `${mode} ${changedPath} (raw)`);
      }
  },
);

unitTest(
  "preparing once makes retrieval independent of raw chunk text and vectors",
  async () => {
    const index = await buildIndex(30);
    let contentReads = 0;
    for (const chunk of index.chunks) {
      const text = chunk.content;
      Object.defineProperty(chunk, "content", {
        enumerable: true,
        get() {
          contentReads++;
          return text;
        },
      });
    }
    let vectorTouches = 0;
    const counted = {
      ...index,
      vectors: new Proxy(index.vectors, {
        ownKeys(target) {
          vectorTouches++;
          return Reflect.ownKeys(target);
        },
        get(target, key, receiver) {
          vectorTouches++;
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    const prepared = prepareRepositoryIndex(counted);
    const afterPrepare = { contentReads, vectorTouches };
    assert.ok(afterPrepare.contentReads >= index.chunks.length);
    assert.ok(afterPrepare.vectorTouches > 0);
    for (let i = 0; i < 10; i++)
      for (const mode of ["lexical", "hybrid"] as const)
        await retrieveContext({
          index: prepared,
          repositoryId: "r",
          revision: "v",
          query: queries[i % queries.length]![1],
          changedPath: queries[i % queries.length]![0],
          mode,
          candidates: 10,
          topK: 3,
          threshold: 0,
          embedding: mode === "hybrid" ? embedding : undefined,
        });
    assert.deepEqual(
      { contentReads, vectorTouches },
      afterPrepare,
      "retrieval must not re-tokenize chunks or rescan stored vectors",
    );
  },
);

unitTest("stored-vector lookup touches only the matching group", async () => {
  const index = await buildIndex(60);
  let providerReads = 0;
  for (const vector of Object.values(index.vectors)) {
    const provider = vector.provider;
    Object.defineProperty(vector, "provider", {
      enumerable: true,
      get() {
        providerReads++;
        return provider;
      },
    });
  }
  const prepared = prepareRepositoryIndex(index);
  providerReads = 0;
  const found = findStoredVector(prepared, prepared.chunks[17]!, embedding);
  assert.equal(found?.inputHash, prepared.chunks[17]!.inputHash);
  assert.ok(
    providerReads <= 2,
    `expected a constant-size lookup, read provider ${providerReads} times`,
  );
  assert.equal(
    findStoredVector(prepared, prepared.chunks[17]!, {
      ...embedding,
      provider: "someone-else",
      model: embedding.model,
      version: embedding.version,
      dimensions: embedding.dimensions,
      embed: embedding.embed.bind(embedding),
    }),
    undefined,
    "a different embedding space never matches",
  );
});

unitTest(
  "prepared index preserves identity checks and is runtime-only",
  async () => {
    const index = await buildIndex(3, false);
    const prepared = prepareRepositoryIndex(index);
    await assert.rejects(
      retrieveContext({
        index: prepared,
        repositoryId: "r",
        revision: "other",
        query: "x",
        changedPath: "x.ts",
        mode: "lexical",
        candidates: 1,
        topK: 1,
        threshold: 0,
      }),
      /stale/,
    );
    // The persisted form stays plain JSON; Sets/Maps live only in the prepared form.
    assert.equal(
      JSON.stringify(JSON.parse(JSON.stringify(index))),
      JSON.stringify(index),
    );
    assert.ok(prepared.chunks[0]!.terms instanceof Set);
    assert.ok(prepared.vectorsByInputHash instanceof Map);
  },
);

unitTest("identical chunk content is returned once per query", async () => {
  const content = "export function shared() { return 'duplicate body'; }";
  const chunks = ["src/one.ts", "src/two.ts"].flatMap((path) =>
    chunkSource({
      repositoryId: "r",
      revision: "v",
      path,
      content,
      maxTokens: 200,
    }).filter((chunk) => chunk.name),
  );
  // Same text, different identity: only the contentHash decides duplication.
  const hash = chunks[0]!.contentHash;
  const aligned = chunks.map((chunk) => ({ ...chunk, contentHash: hash }));
  const result = await retrieveContext({
    index: {
      schemaVersion: 1,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: "r",
      revision: "v",
      maxChunkTokens: 200,
      createdAt: "now",
      chunks: aligned,
      vectors: {},
    },
    repositoryId: "r",
    revision: "v",
    query: "shared duplicate body",
    changedPath: "src/app.ts",
    mode: "lexical",
    candidates: 5,
    topK: 5,
    threshold: 0,
  });
  assert.equal(result.length, 1);
});

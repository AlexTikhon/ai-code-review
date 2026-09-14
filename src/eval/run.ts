import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chunkSource } from "../retrieval/chunker.js";
import { DeterministicTestEmbedding } from "../retrieval/embeddings.js";
import { retrieveContext } from "../retrieval/retrieve.js";
import { CHUNKER_VERSION, type RepositoryIndex } from "../retrieval/types.js";
import { estimateTokens } from "../review/patch.js";
type Example = {
  id: string;
  split: "tuning" | "heldout";
  changedPath: string;
  patch: string;
  documents: Array<{ path: string; content: string }>;
  relevantPaths: string[];
  expectedFindings: string[];
  clean: boolean;
  incomplete?: boolean;
};
async function loadCorpus(): Promise<Example[]> {
  for (const relative of [
    "../../eval/corpus.json",
    "../../../eval/corpus.json",
  ]) {
    try {
      return JSON.parse(
        await readFile(
          fileURLToPath(new URL(relative, import.meta.url)),
          "utf8",
        ),
      ) as Example[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Cannot locate eval/corpus.json");
}
function detect(example: Example, contextPaths: Set<string>): string[] {
  const found: string[] = [];
  if (
    /user\.profile\.id/.test(example.patch) &&
    !/!user\.profile/.test(example.patch)
  )
    found.push("null-deref");
  if (
    /maxRetries:\s*"five"/.test(example.patch) &&
    contextPaths.has("src/types.ts")
  )
    found.push("cross-file-type");
  if (/input!\.id/.test(example.patch)) found.push("unsafe-assertion");
  return found;
}
async function evaluate(
  examples: Example[],
  mode: "diff" | "lexical" | "hybrid",
) {
  let relevant = 0;
  let recalled = 0;
  let reciprocalRank = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let cleanFalsePositives = 0;
  let reviewed = 0;
  let estimatedTokens = 0;
  const started = performance.now();
  const embedding = new DeterministicTestEmbedding();
  for (const example of examples) {
    const chunks = example.documents.flatMap((document) =>
      chunkSource({
        repositoryId: example.id,
        revision: "fixture-v1",
        path: document.path,
        content: document.content,
        maxTokens: 200,
      }),
    );
    const vectors: RepositoryIndex["vectors"] = {};
    for (const chunk of chunks) {
      const key = `${chunk.contentHash}:${embedding.model}:${embedding.version}:${CHUNKER_VERSION}`;
      vectors[key] = {
        cacheKey: key,
        values: (await embedding.embed([chunk.content]))[0]!,
      };
    }
    const index: RepositoryIndex = {
      schemaVersion: 1,
      chunkerVersion: CHUNKER_VERSION,
      repositoryId: example.id,
      revision: "fixture-v1",
      createdAt: "fixture",
      chunks,
      vectors,
    };
    const candidates =
      mode === "diff"
        ? []
        : await retrieveContext({
            index,
            repositoryId: example.id,
            revision: "fixture-v1",
            query: `${example.changedPath}\n${example.patch}`,
            changedPath: example.changedPath,
            mode,
            candidates: 10,
            topK: 3,
            threshold: 0,
            embedding: mode === "hybrid" ? embedding : undefined,
          });
    const paths = candidates.map((candidate) => candidate.chunk.path);
    estimatedTokens += estimateTokens(
      example.patch +
        candidates.map((candidate) => candidate.chunk.content).join("\n"),
    );
    for (const path of example.relevantPaths) {
      relevant++;
      const rank = paths.indexOf(path);
      if (rank >= 0) {
        recalled++;
        reciprocalRank += 1 / (rank + 1);
      }
    }
    const actual = new Set(detect(example, new Set(paths)));
    const expected = new Set(example.expectedFindings);
    for (const finding of actual) expected.has(finding) ? tp++ : fp++;
    for (const finding of expected) if (!actual.has(finding)) fn++;
    if (example.clean && actual.size) cleanFalsePositives++;
    if (!example.incomplete) reviewed++;
  }
  return {
    retrievalRecallAt3: relevant ? recalled / relevant : null,
    retrievalMRR: relevant ? reciprocalRank / relevant : null,
    findingPrecision: tp + fp ? tp / (tp + fp) : null,
    findingRecall: tp + fn ? tp / (tp + fn) : null,
    cleanFalsePositiveRate: examples.filter((e) => e.clean).length
      ? cleanFalsePositives / examples.filter((e) => e.clean).length
      : null,
    coverage: reviewed / examples.length,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    estimatedTokens,
    counts: {
      examples: examples.length,
      tp,
      fp,
      fn,
      relevantQueries: relevant,
    },
  };
}
async function main() {
  const corpus = await loadCorpus();
  const output: Record<string, unknown> = {
    kind: "deterministic-mocked-baseline",
    caveat:
      "Rule-based findings and deterministic test embeddings measure harness/retrieval behavior, not real-model quality.",
  };
  for (const split of ["tuning", "heldout"] as const) {
    const examples = corpus.filter((item) => item.split === split);
    output[split] = Object.fromEntries(
      await Promise.all(
        (["diff", "lexical", "hybrid"] as const).map(async (mode) => [
          mode,
          await evaluate(examples, mode),
        ]),
      ),
    );
  }
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

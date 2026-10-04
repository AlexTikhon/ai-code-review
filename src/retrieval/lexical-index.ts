import type { ContextChunk, RetrievalCandidate } from "./types.js";

/** Lexical terms shared by index preparation and query tokenization. */
export function lexicalTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []);
}

/**
 * Inverted lookup tables over one repository snapshot. Every list holds
 * document ordinals (positions in `documents`) in ascending order, so ties
 * resolve in repository order without a separate sort key.
 *
 * Runtime-only: it holds Maps and is rebuilt from the persisted chunks.
 */
export type LexicalIndex = {
  /** Chunks in deterministic repository order. */
  readonly documents: readonly ContextChunk[];
  /** term -> documents whose path/name/signature/imports/content contain it. */
  readonly postings: ReadonlyMap<string, readonly number[]>;
  /** lower-cased symbol name -> documents with that name. */
  readonly symbolDocuments: ReadonlyMap<string, readonly number[]>;
  /** file path -> documents in that file. */
  readonly pathDocuments: ReadonlyMap<string, readonly number[]>;
  /** import needle (leading "./" removed) -> documents importing it. */
  readonly importDocuments: ReadonlyMap<string, readonly number[]>;
};

/** Structural work counters; independent of wall-clock time. */
export type LexicalWork = {
  /** Posting entries visited for the query's terms. */
  postingsExamined: number;
  /** Documents that scored above zero. */
  documentsScored: number;
  /** Distinct import needles compared with the changed path. */
  importNeedlesTested: number;
  /** Zero-score documents appended to reach the candidate limit. */
  documentsFilled: number;
};

function append<K>(map: Map<K, number[]>, key: K, ordinal: number): void {
  const list = map.get(key);
  if (list) list.push(ordinal);
  else map.set(key, [ordinal]);
}

export function buildLexicalIndex(
  documents: readonly ContextChunk[],
): LexicalIndex {
  const postings = new Map<string, number[]>();
  const symbolDocuments = new Map<string, number[]>();
  const pathDocuments = new Map<string, number[]>();
  const importDocuments = new Map<string, number[]>();
  documents.forEach((chunk, ordinal) => {
    const terms = lexicalTokens(
      `${chunk.path} ${chunk.name ?? ""} ${chunk.signature ?? ""} ${chunk.imports.join(" ")} ${chunk.content}`,
    );
    for (const term of terms) append(postings, term, ordinal);
    if (chunk.name) append(symbolDocuments, chunk.name.toLowerCase(), ordinal);
    append(pathDocuments, chunk.path, ordinal);
    const needles = new Set(
      chunk.imports.map((item) => item.replace(/^\.\//, "")),
    );
    for (const needle of needles) append(importDocuments, needle, ordinal);
  });
  return {
    documents,
    postings,
    symbolDocuments,
    pathDocuments,
    importDocuments,
  };
}

/** Above this limit a full sort is as cheap as bounded selection. */
const BOUNDED_SELECTION_LIMIT = 64;

type Hit = {
  overlap: number;
  importLinked: boolean;
  symbolMatched: boolean;
  sameFile: boolean;
};

/**
 * The shortlist the full-scan scorer would produce, computed from postings.
 *
 * Score = min(1, overlap/|query terms| + import 0.2 + symbol 0.35 + same-file
 * 0.05), exactly as before. Only documents reached through a posting, import,
 * symbol or path list can score above zero, so only those are scored; they are
 * ordered by score, then repository order (the full scan's stable sort). If
 * that leaves room, zero-score documents follow in repository order, which is
 * where the full scan's stable sort placed them too.
 */
export function rankLexicalCandidates(
  index: LexicalIndex,
  query: string,
  changedPath: string,
  limit: number,
): { candidates: RetrievalCandidate[]; work: LexicalWork } {
  const wanted = Math.max(0, Math.floor(limit));
  const queryTokens = lexicalTokens(query);
  const work: LexicalWork = {
    postingsExamined: 0,
    documentsScored: 0,
    importNeedlesTested: 0,
    documentsFilled: 0,
  };
  const hits = new Map<number, Hit>();
  const hit = (ordinal: number): Hit => {
    let entry = hits.get(ordinal);
    if (!entry) {
      entry = {
        overlap: 0,
        importLinked: false,
        symbolMatched: false,
        sameFile: false,
      };
      hits.set(ordinal, entry);
    }
    return entry;
  };
  for (const token of queryTokens) {
    const postings = index.postings.get(token) ?? [];
    work.postingsExamined += postings.length;
    for (const ordinal of postings) hit(ordinal).overlap++;
    for (const ordinal of index.symbolDocuments.get(token) ?? [])
      hit(ordinal).symbolMatched = true;
  }
  for (const [needle, ordinals] of index.importDocuments) {
    work.importNeedlesTested++;
    if (changedPath.includes(needle))
      for (const ordinal of ordinals) hit(ordinal).importLinked = true;
  }
  for (const ordinal of index.pathDocuments.get(changedPath) ?? [])
    hit(ordinal).sameFile = true;

  const scoreOf = (entry: Hit): number =>
    Math.min(
      1,
      (queryTokens.size ? entry.overlap / queryTokens.size : 0) +
        (entry.importLinked ? 0.2 : 0) +
        (entry.symbolMatched ? 0.35 : 0) +
        (entry.sameFile ? 0.05 : 0),
    );
  work.documentsScored = hits.size;

  // Order: score descending, then repository order (the full scan's stable
  // sort). For a small limit only the best `wanted` are tracked, so cost is
  // O(hits) instead of O(hits log hits), and reasons are built only for them.
  type Ranked = { ordinal: number; score: number; entry: Hit };
  let selected: Ranked[] = [];
  if (wanted > 0 && (wanted > BOUNDED_SELECTION_LIMIT || hits.size <= wanted)) {
    selected = [...hits]
      .map(([ordinal, entry]) => ({ ordinal, score: scoreOf(entry), entry }))
      .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
      .slice(0, wanted);
  } else if (wanted > 0) {
    for (const [ordinal, entry] of hits) {
      const score = scoreOf(entry);
      const worst = selected[wanted - 1];
      if (
        worst &&
        !(
          score > worst.score ||
          (score === worst.score && ordinal < worst.ordinal)
        )
      )
        continue;
      let position = selected.length;
      while (
        position > 0 &&
        (score > selected[position - 1]!.score ||
          (score === selected[position - 1]!.score &&
            ordinal < selected[position - 1]!.ordinal))
      )
        position--;
      selected.splice(position, 0, { ordinal, score, entry });
      if (selected.length > wanted) selected.pop();
    }
  }
  const candidates: RetrievalCandidate[] = selected.map(
    ({ ordinal, score, entry }) => ({
      chunk: index.documents[ordinal]!,
      score,
      reasons: [
        entry.overlap ? `keyword-overlap:${entry.overlap}` : "",
        entry.importLinked ? "import-link" : "",
        entry.symbolMatched ? "symbol-match" : "",
        entry.sameFile ? "same-file" : "",
      ].filter(Boolean),
    }),
  );
  for (
    let ordinal = 0;
    candidates.length < wanted && ordinal < index.documents.length;
    ordinal++
  ) {
    if (hits.has(ordinal)) continue;
    candidates.push({
      chunk: index.documents[ordinal]!,
      score: 0,
      reasons: [],
    });
    work.documentsFilled++;
  }
  return { candidates, work };
}

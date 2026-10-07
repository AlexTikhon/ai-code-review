import { createHash } from "node:crypto";
import type { PatchSegment } from "./types.js";

const MAX_PATCH_LENGTH = 15000;

/** Conservative fallback: one UTF-8 byte consumes one token of budget. */
export function estimateTokens(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getMaxPatchLength(): number {
  return MAX_PATCH_LENGTH;
}

export function splitPatchIntoSections(patch: string): {
  preamble: string;
  hunks: string[];
} {
  const lines = patch.split("\n");
  const preamble: string[] = [];
  const hunks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current.join("\n"));
      current = [line];
    } else if (current) current.push(line);
    else preamble.push(line);
  }
  if (current) hunks.push(current.join("\n"));
  return { preamble: preamble.join("\n"), hunks };
}

type ParsedLine = {
  text: string;
  kind?: "context" | "addition" | "deletion";
  oldLine?: number;
  newLine?: number;
  complete: boolean;
};

function parsePatchLines(patch: string): ParsedLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return patch.split("\n").map((text) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      return { text, complete: true };
    }
    if (oldLine === undefined || newLine === undefined)
      return { text, complete: true };
    if (text.startsWith("+")) {
      const parsed = {
        text,
        kind: "addition" as const,
        newLine,
        complete: true,
      };
      newLine++;
      return parsed;
    }
    if (text.startsWith("-")) {
      const parsed = {
        text,
        kind: "deletion" as const,
        oldLine,
        complete: true,
      };
      oldLine++;
      return parsed;
    }
    if (text.startsWith(" ")) {
      const parsed = {
        text,
        kind: "context" as const,
        oldLine,
        newLine,
        complete: true,
      };
      oldLine++;
      newLine++;
      return parsed;
    }
    return { text, complete: true };
  });
}

export function changedLineNumbers(patch: string): Set<number> {
  return new Set(
    parsePatchLines(patch)
      .filter(
        (line) =>
          line.kind === "addition" &&
          line.complete &&
          line.newLine !== undefined &&
          line.newLine > 0,
      )
      .map((line) => line.newLine!),
  );
}

function ranges(lines: number[]): Array<{ start: number; end: number }> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  for (const line of sorted) {
    const last = out.at(-1);
    if (last && line <= last.end + 1) last.end = line;
    else out.push({ start: line, end: line });
  }
  return out;
}

/**
 * Build one segment from its own lines. Offsets, mappings, valid ranges and
 * the content-derived id are always recomputed here, never carried over from a
 * larger pre-split segment.
 */
function buildSegment(group: ParsedLine[], truncated: boolean): PatchSegment {
  const text = group.map((line) => line.text).join("\n");
  const lineMappings = group.flatMap((line, index) =>
    line.kind
      ? [
          {
            segmentLine: index + 1,
            kind: line.kind,
            oldLine: line.oldLine,
            newLine: line.newLine,
            complete: line.complete,
          },
        ]
      : [],
  );
  const lineRanges = ranges(
    lineMappings
      .filter(
        (line) =>
          line.kind === "addition" &&
          line.complete &&
          line.newLine !== undefined &&
          line.newLine > 0,
      )
      .map((line) => line.newLine!),
  );
  return {
    id: createHash("sha256")
      .update(text)
      .update(JSON.stringify(lineMappings))
      .digest("hex")
      .slice(0, 16),
    text,
    lineRanges,
    lineMappings,
    truncated: truncated || group.some((line) => !line.complete),
  };
}

/** Does a candidate segment fit its request budget? Must be monotonic. */
export type SegmentFit = (candidate: PatchSegment) => boolean;

/**
 * The independent per-segment patch cap: the segment text plus its line
 * separator may not exceed `maxTokens` (one UTF-8 byte is one token).
 */
export function patchCapFits(segment: PatchSegment, maxTokens: number) {
  return estimateTokens(`${segment.text}\n`) <= Math.max(1, maxTokens);
}

/**
 * Largest `n` such that `lines[start, start + n)` fits as one segment, or 0.
 * A segment only grows when a line is added, so fit is monotonic in `n`;
 * galloping then bisecting keeps the probes proportional to the segment size.
 */
function largestFit(lines: ParsedLine[], start: number, fits: SegmentFit) {
  const max = lines.length - start;
  const ok = (n: number) =>
    fits(buildSegment(lines.slice(start, start + n), false));
  if (!ok(1)) return 0;
  let good = 1;
  let bad = max + 1;
  while (good < max) {
    const probe = Math.min(good * 2, max);
    if (!ok(probe)) {
      bad = probe;
      break;
    }
    good = probe;
  }
  while (bad - good > 1) {
    const mid = good + Math.floor((bad - good) / 2);
    if (ok(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

const PARTIAL_SUFFIX = " [PARTIAL LINE; NOT CITABLE]";

/**
 * Split a line that cannot fit alone into pieces that each fit alone. Every
 * piece keeps the original coordinates but is marked incomplete, so it can
 * never be cited. At most `maxPieces` are produced; `exhausted` reports that
 * content remained. No pieces means not even a minimal fragment fits.
 */
function partialPieces(
  line: ParsedLine,
  maxPieces: number,
  fits: SegmentFit,
): { pieces: ParsedLine[]; exhausted: boolean } {
  const prefix = line.kind
    ? line.kind === "addition"
      ? "+"
      : line.kind === "deletion"
        ? "-"
        : " "
    : "";
  const characters = Array.from(line.kind ? line.text.slice(1) : line.text);
  const piece = (from: number, count: number, suffix: string): ParsedLine => ({
    ...line,
    text: `${prefix}${characters.slice(from, from + count).join("")}${suffix}`,
    complete: false,
  });
  const fitsAlone = (candidate: ParsedLine) =>
    fits(buildSegment([candidate], false));
  const suffix = fitsAlone(piece(0, 1, PARTIAL_SUFFIX)) ? PARTIAL_SUFFIX : "";
  if (!characters.length || !fitsAlone(piece(0, 1, suffix)))
    return { pieces: [], exhausted: false };
  const pieces: ParsedLine[] = [];
  let from = 0;
  while (from < characters.length && pieces.length < maxPieces) {
    const remaining = characters.length - from;
    let good = 1;
    let bad = remaining + 1;
    while (good < remaining) {
      const probe = Math.min(good * 2, remaining);
      if (!fitsAlone(piece(from, probe, suffix))) {
        bad = probe;
        break;
      }
      good = probe;
    }
    while (bad - good > 1) {
      const mid = good + Math.floor((bad - good) / 2);
      if (fitsAlone(piece(from, mid, suffix))) good = mid;
      else bad = mid;
    }
    pieces.push(piece(from, good, suffix));
    from += good;
  }
  return { pieces, exhausted: from < characters.length };
}

export type PatchPlan = {
  segments: PatchSegment[];
  /**
   * Some content is not presented as a complete, citable line: it was omitted
   * past the segment cap or could not be fitted at all. Individual partial
   * lines are additionally marked on their own segments.
   */
  truncated: boolean;
};

/**
 * Deterministically fit a patch into at most `maxSegments` segments, each of
 * which satisfies `fits`. Parses coordinates once, packs whole lines greedily,
 * and carries the original coordinates into every segment. A line that cannot
 * fit alone is split into non-citable fragments; one that cannot be fragmented
 * is dropped. Either way the plan is reported truncated, never complete.
 */
export function planPatchSegments(
  patch: string,
  maxSegments: number,
  fits: SegmentFit,
): PatchPlan {
  const lines = parsePatchLines(patch);
  const groups: ParsedLine[][] = [];
  let truncated = false;
  let index = 0;
  while (index < lines.length) {
    if (groups.length >= maxSegments) {
      truncated = true;
      break;
    }
    const count = largestFit(lines, index, fits);
    if (count > 0) {
      groups.push(lines.slice(index, index + count));
      index += count;
      continue;
    }
    const { pieces, exhausted } = partialPieces(
      lines[index]!,
      maxSegments - groups.length,
      fits,
    );
    truncated = truncated || exhausted || pieces.length === 0;
    lines.splice(index, 1, ...pieces);
  }
  return {
    segments: groups.map((group) => buildSegment(group, truncated)),
    truncated,
  };
}

/**
 * Text-only segmentation: bounds each segment's patch text by `maxTokens` and
 * knows nothing about the rest of a request. The review pipeline plans with
 * planReviewSegments (request-plan.ts), which fits the full request.
 */
export function splitPatchForReview(
  patch: string,
  maxTokens: number,
  maxSegments: number,
): PatchSegment[] {
  return planPatchSegments(patch, maxSegments, (segment) =>
    patchCapFits(segment, maxTokens),
  ).segments;
}

export function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_LENGTH) return patch;
  return `${patch.slice(0, MAX_PATCH_LENGTH - 80)}\n[TRUNCATED: patch exceeded review size limit]`;
}

import { createHash } from "node:crypto";
import type { PatchSegment } from "./types.js";

const MAX_PATCH_LENGTH = 15000;

/** Conservative fallback: one UTF-8 byte consumes one token of budget. */
export function estimateTokens(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function takeUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
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

function splitOversizedLine(line: ParsedLine, maxBytes: number): ParsedLine[] {
  const prefix = line.kind
    ? line.kind === "addition"
      ? "+"
      : line.kind === "deletion"
        ? "-"
        : " "
    : "";
  let remaining = line.kind ? line.text.slice(1) : line.text;
  const pieces: ParsedLine[] = [];
  const longSuffix = " [PARTIAL LINE; NOT CITABLE]";
  const suffix =
    Buffer.byteLength(prefix + longSuffix + "\n", "utf8") <= maxBytes
      ? longSuffix
      : "";
  const contentBudget = maxBytes - Buffer.byteLength(prefix + suffix, "utf8");
  if (contentBudget <= 0)
    return [
      {
        ...line,
        text: takeUtf8(prefix, maxBytes),
        complete: false,
      },
    ];
  while (remaining) {
    const part = takeUtf8(remaining, contentBudget);
    if (!part) break;
    pieces.push({
      ...line,
      text: `${prefix}${part}${suffix}`,
      complete: false,
    });
    remaining = remaining.slice(part.length);
  }
  return pieces.length
    ? pieces
    : [{ ...line, text: `${prefix}${suffix}`, complete: false }];
}

/** Parse coordinates once and carry them into every bounded segment. */
export function splitPatchForReview(
  patch: string,
  maxTokens: number,
  maxSegments: number,
): PatchSegment[] {
  const maxBytes = Math.max(1, maxTokens);
  const pieces = parsePatchLines(patch).flatMap((line) =>
    Buffer.byteLength(`${line.text}\n`, "utf8") <= maxBytes
      ? [line]
      : splitOversizedLine(line, maxBytes),
  );
  const groups: ParsedLine[][] = [];
  let current: ParsedLine[] = [];
  let size = 0;
  for (const piece of pieces) {
    const next = Buffer.byteLength(`${piece.text}\n`, "utf8");
    if (current.length && size + next > maxBytes) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += next;
  }
  if (current.length) groups.push(current);
  const omitted = groups.length > maxSegments;
  return groups.slice(0, maxSegments).map((group) => {
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
      truncated: omitted || group.some((line) => !line.complete),
    };
  });
}

export function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_LENGTH) return patch;
  return `${patch.slice(0, MAX_PATCH_LENGTH - 80)}\n[TRUNCATED: patch exceeded review size limit]`;
}

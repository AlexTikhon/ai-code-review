import { createHash } from "node:crypto";
import type { PatchSegment } from "./types.js";

const MAX_PATCH_LENGTH = 15000;
export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
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

export function changedLineNumbers(patch: string): Set<number> {
  const result = new Set<number>();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.add(newLine);
      newLine += 1;
    } else if (
      !line.startsWith("-") &&
      !line.startsWith("diff ") &&
      !line.startsWith("index ") &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    )
      newLine += 1;
  }
  return result;
}

function ranges(lines: Set<number>): Array<{ start: number; end: number }> {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  for (const line of sorted) {
    const last = out.at(-1);
    if (last && line <= last.end + 1) last.end = line;
    else out.push({ start: line, end: line });
  }
  return out;
}

/** Splits at diff lines, including within a single oversized hunk/line, and reports omitted coverage. */
export function splitPatchForReview(
  patch: string,
  maxTokens: number,
  maxSegments: number,
): PatchSegment[] {
  const maxBytes = Math.max(256, maxTokens * 3);
  const rawLines = patch.split("\n");
  const pieces: string[] = [];
  let mappedNewLine = 0;
  for (const line of rawLines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) mappedNewLine = Number(header[1]);
    const bytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes <= maxBytes) pieces.push(line);
    else {
      let remaining = line.slice(line.startsWith("+") ? 1 : 0);
      const prefix =
        line.startsWith("+") && !line.startsWith("+++")
          ? `@@ -0,0 +${mappedNewLine},1 @@\n+`
          : "";
      while (remaining) {
        const part = takeUtf8(
          remaining,
          Math.max(32, maxBytes - Buffer.byteLength(prefix, "utf8") - 80),
        );
        pieces.push(`${prefix}${part} [LINE-SPLIT]`);
        remaining = remaining.slice(part.length);
      }
    }
    if (line.startsWith("+") && !line.startsWith("+++")) mappedNewLine++;
    else if (
      !line.startsWith("-") &&
      !line.startsWith("diff ") &&
      !line.startsWith("index ") &&
      !line.startsWith("---") &&
      !line.startsWith("+++ ") &&
      !line.startsWith("@@")
    )
      mappedNewLine++;
  }
  const groups: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const piece of pieces) {
    const next = Buffer.byteLength(`${piece}\n`, "utf8");
    if (current.length && size + next > maxBytes) {
      groups.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(piece);
    size += next;
  }
  if (current.length) groups.push(current.join("\n"));
  const omitted = groups.length > maxSegments;
  const selected = groups.slice(0, maxSegments);
  return selected.map((text, index) => {
    const marker =
      omitted && index === selected.length - 1
        ? "\n[TRUNCATED: additional diff segments were not reviewed]"
        : "";
    const bounded = `${text}${marker}`;
    const safe =
      estimateTokens(bounded) <= maxTokens
        ? bounded
        : takeUtf8(bounded, maxBytes - 100) +
          "\n[TRUNCATED: segment byte limit]";
    return {
      id: createHash("sha256").update(safe).digest("hex").slice(0, 16),
      text: safe,
      lineRanges: ranges(changedLineNumbers(safe)),
      truncated: omitted || safe.length < bounded.length,
    };
  });
}

export function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_LENGTH) return patch;
  return `${patch.slice(0, MAX_PATCH_LENGTH - 80)}\n[TRUNCATED: patch exceeded review size limit]`;
}

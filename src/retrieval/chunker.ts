import { createHash } from "node:crypto";
import { extname } from "node:path";
import { estimateTokens } from "../review/patch.js";
import { CHUNKER_VERSION, type ContextChunk } from "./types.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const SYMBOL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const IMPORT =
  /^\s*(?:import(?:[\s\S]*?from\s*)?|export[\s\S]*?from\s*)["']([^"']+)["']|^\s*(?:const|let|var).*=\s*require\(["']([^"']+)["']\)/;
function language(path: string): ContextChunk["language"] {
  const ext = extname(path).toLowerCase();
  return [".ts", ".tsx"].includes(ext)
    ? "typescript"
    : [".js", ".jsx", ".mjs", ".cjs"].includes(ext)
      ? "javascript"
      : "fallback";
}
function braceDelta(line: string): number {
  return (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
}
function makeChunk(
  base: Omit<
    ContextChunk,
    "id" | "contentHash" | "startLine" | "endLine" | "content"
  >,
  lines: string[],
  start: number,
): ContextChunk {
  const content = lines.join("\n");
  const contentHash = hash(content);
  return {
    ...base,
    startLine: start,
    endLine: start + lines.length - 1,
    content,
    contentHash,
    id: hash(
      `${base.repositoryId}\0${base.revision}\0${base.path}\0${start}\0${contentHash}\0${CHUNKER_VERSION}`,
    ).slice(0, 24),
  };
}
function splitBounded(
  base: Omit<
    ContextChunk,
    "id" | "contentHash" | "startLine" | "endLine" | "content"
  >,
  lines: string[],
  start: number,
  maxTokens: number,
): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  let current: string[] = [];
  let currentStart = start;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (
      current.length &&
      estimateTokens([...current, line].join("\n")) > maxTokens
    ) {
      chunks.push(makeChunk(base, current, currentStart));
      current = [];
      currentStart = start + index;
    }
    if (estimateTokens(line) > maxTokens) {
      const width = maxTokens * 3;
      for (let offset = 0; offset < line.length; offset += width)
        chunks.push(
          makeChunk(base, [line.slice(offset, offset + width)], start + index),
        );
      currentStart = start + index + 1;
    } else current.push(line);
  }
  if (current.length) chunks.push(makeChunk(base, current, currentStart));
  return chunks;
}
export function chunkSource(input: {
  repositoryId: string;
  revision: string;
  path: string;
  content: string;
  maxTokens: number;
}): ContextChunk[] {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  const lang = language(input.path);
  const imports = lines
    .map((line) => IMPORT.exec(line))
    .filter(Boolean)
    .map((match) => match?.[1] ?? match?.[2] ?? "")
    .filter(Boolean);
  const common = {
    repositoryId: input.repositoryId,
    revision: input.revision,
    path: input.path,
    language: lang,
    imports,
  };
  if (lang === "fallback")
    return splitBounded({ ...common, kind: "file" }, lines, 1, input.maxTokens);
  const chunks: ContextChunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = SYMBOL.exec(lines[index]!);
    if (!match) {
      index++;
      continue;
    }
    const start = index;
    let depth = 0;
    let sawBrace = false;
    do {
      const delta = braceDelta(lines[index]!);
      if (lines[index]!.includes("{")) sawBrace = true;
      depth += delta;
      index++;
    } while (
      index < lines.length &&
      ((sawBrace && depth > 0) || (!sawBrace && index === start + 1))
    );
    const signature = lines[start]!.trim().slice(0, 300);
    chunks.push(
      ...splitBounded(
        { ...common, kind: "symbol", name: match[1], signature },
        lines.slice(start, index),
        start + 1,
        input.maxTokens,
      ),
    );
  }
  if (!chunks.length)
    return splitBounded({ ...common, kind: "file" }, lines, 1, input.maxTokens);
  return chunks;
}

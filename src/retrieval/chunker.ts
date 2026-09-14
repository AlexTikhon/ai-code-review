import { createHash } from "node:crypto";
import { extname } from "node:path";
import ts from "typescript";
import { estimateTokens } from "../review/patch.js";
import { CHUNKER_VERSION, type ContextChunk } from "./types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function language(path: string): ContextChunk["language"] {
  const ext = extname(path).toLowerCase();
  return [".ts", ".tsx"].includes(ext)
    ? "typescript"
    : [".js", ".jsx", ".mjs", ".cjs"].includes(ext)
      ? "javascript"
      : "fallback";
}

function takeUtf8(value: string, maxBytes: number): string {
  let output = "";
  let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > maxBytes) break;
    output += character;
    size += bytes;
  }
  return output;
}

type ChunkBase = Omit<
  ContextChunk,
  | "id"
  | "contentHash"
  | "startLine"
  | "endLine"
  | "content"
  | "contentComplete"
  | "omissionReason"
>;

function makeChunk(
  base: ChunkBase,
  content: string,
  startLine: number,
  endLine: number,
  contentComplete = true,
  omissionReason?: string,
): ContextChunk {
  const contentHash = hash(content);
  return {
    ...base,
    startLine,
    endLine,
    content,
    contentComplete,
    omissionReason,
    contentHash,
    id: hash(
      `${base.repositoryId}\0${base.revision}\0${base.path}\0${startLine}\0${endLine}\0${contentHash}\0${CHUNKER_VERSION}`,
    ).slice(0, 24),
  };
}

function splitBounded(
  base: ChunkBase,
  lines: string[],
  startLine: number,
  maxTokens: number,
): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  let current: string[] = [];
  let currentStart = startLine;
  const flush = () => {
    if (!current.length) return;
    chunks.push(
      makeChunk(
        base,
        current.join("\n"),
        currentStart,
        currentStart + current.length - 1,
      ),
    );
    current = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (
      current.length &&
      estimateTokens([...current, line].join("\n")) > maxTokens
    ) {
      flush();
      currentStart = startLine + index;
    }
    if (estimateTokens(line) > maxTokens) {
      flush();
      let remaining = line;
      while (remaining) {
        const part = takeUtf8(remaining, maxTokens);
        if (!part) {
          chunks.push(
            makeChunk(
              base,
              "",
              startLine + index,
              startLine + index,
              false,
              "A code point exceeded the configured chunk budget.",
            ),
          );
          break;
        }
        chunks.push(
          makeChunk(base, part, startLine + index, startLine + index, false),
        );
        remaining = remaining.slice(part.length);
      }
      currentStart = startLine + index + 1;
    } else {
      if (!current.length) currentStart = startLine + index;
      current.push(line);
    }
  }
  flush();
  return chunks;
}

function symbolName(statement: ts.Statement): string | undefined {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  )
    return statement.name?.text;
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
      )
      .filter((name): name is string => Boolean(name));
    return names.length ? names.join(",") : undefined;
  }
  return undefined;
}

function scriptKind(path: string): ts.ScriptKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  return [".js", ".mjs", ".cjs"].includes(ext)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

export function chunkSource(input: {
  repositoryId: string;
  revision: string;
  path: string;
  content: string;
  maxTokens: number;
}): ContextChunk[] {
  const normalized = input.content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const lang = language(input.path);
  if (lang === "fallback")
    return splitBounded(
      {
        repositoryId: input.repositoryId,
        revision: input.revision,
        path: input.path,
        language: lang,
        kind: "file",
        imports: [],
      },
      lines,
      1,
      input.maxTokens,
    );

  const sourceFile = ts.createSourceFile(
    input.path,
    normalized,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(input.path),
  );
  const imports = sourceFile.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    )
      return [statement.moduleSpecifier.text];
    if (ts.isImportEqualsDeclaration(statement))
      return [statement.moduleReference.getText(sourceFile)];
    return [];
  });
  const common = {
    repositoryId: input.repositoryId,
    revision: input.revision,
    path: input.path,
    language: lang,
    imports,
  };
  const chunks: ContextChunk[] = [];
  let nextFallbackLine = 0;
  const addFallback = (start: number, endExclusive: number) => {
    if (endExclusive <= start) return;
    chunks.push(
      ...splitBounded(
        { ...common, kind: "file" },
        lines.slice(start, endExclusive),
        start + 1,
        input.maxTokens,
      ),
    );
  };
  for (const statement of sourceFile.statements) {
    const name = symbolName(statement);
    if (!name) continue;
    const start = sourceFile.getLineAndCharacterOfPosition(
      statement.getStart(sourceFile),
    ).line;
    const end =
      sourceFile.getLineAndCharacterOfPosition(
        Math.max(statement.getStart(sourceFile), statement.getEnd() - 1),
      ).line + 1;
    addFallback(nextFallbackLine, start);
    const statementText = statement.getText(sourceFile);
    const signature = statementText.replace(/\s+/g, " ").slice(0, 300);
    chunks.push(
      ...splitBounded(
        { ...common, kind: "symbol", name, signature },
        lines.slice(start, end),
        start + 1,
        input.maxTokens,
      ),
    );
    nextFallbackLine = Math.max(nextFallbackLine, end);
  }
  addFallback(nextFallbackLine, lines.length);
  return chunks.length
    ? chunks
    : splitBounded({ ...common, kind: "file" }, lines, 1, input.maxTokens);
}

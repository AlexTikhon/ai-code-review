import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

export type IgnoreRule = { pattern: string; negated: boolean };
export type LoadedIgnore = {
  rules: IgnoreRule[];
  matcher: Ignore;
  path: string;
};
export function parseIgnoreFile(contents: string): IgnoreRule[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => ({
      negated: line.startsWith("!"),
      pattern: line.startsWith("!") ? line.slice(1) : line,
    }))
    .filter((rule) => Boolean(rule.pattern));
}
export async function loadIgnorePolicy(
  repositoryRoot: string,
): Promise<LoadedIgnore> {
  const path = resolve(repositoryRoot, ".ai-reviewer-ignore");
  try {
    const contents = await readFile(path, "utf8");
    return {
      path,
      rules: parseIgnoreFile(contents),
      matcher: ignore().add(contents),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, rules: [], matcher: ignore() };
    throw new Error(
      `Cannot read optional ignore file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function loadIgnoreRules(
  repositoryRoot: string,
): Promise<IgnoreRule[]> {
  return (await loadIgnorePolicy(repositoryRoot)).rules;
}
export function isIgnoredPath(
  filename: string,
  rulesOrPolicy: IgnoreRule[] | LoadedIgnore,
): boolean {
  const normalized = filename.replaceAll("\\", "/").replace(/^\/+/, "");
  const matcher = Array.isArray(rulesOrPolicy)
    ? ignore().add(
        rulesOrPolicy.map(
          (rule) => `${rule.negated ? "!" : ""}${rule.pattern}`,
        ),
      )
    : rulesOrPolicy.matcher;
  return matcher.ignores(normalized);
}

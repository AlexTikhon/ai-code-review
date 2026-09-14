import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SourceFile } from "../review/types.js";

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "secrets.yml",
  "secrets.yaml",
  "terraform.tfstate",
  ".netrc",
  "auth.json",
  "secret.json",
  "secrets.json",
]);
const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
];
const SENSITIVE_PATH_PARTS = [
  ".aws/credentials",
  ".ssh/",
  ".gnupg/",
  ".kube/config",
];
const SECRET_PATTERNS: Array<{ name: string; expression: RegExp }> = [
  {
    name: "private key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  },
  { name: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  {
    name: "generic credential assignment",
    expression:
      /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-\/.+=]{16,}/i,
  },
];
export type PrivacyDecision = {
  allowed: boolean;
  reason?: "sensitive_path" | "sensitive_content" | "symlink";
  details?: string;
};
export function isMandatorySensitivePath(filename: string): boolean {
  const normalized = filename
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (basename.startsWith(".env")) return true;
  return (
    SENSITIVE_BASENAMES.has(basename) ||
    SENSITIVE_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
    SENSITIVE_PATH_PARTS.some(
      (part) => normalized === part || normalized.includes(`/${part}`),
    )
  );
}
export function inspectSensitiveContent(value: string): string | undefined {
  for (const pattern of SECRET_PATTERNS)
    if (pattern.expression.test(value)) return pattern.name;
  return undefined;
}
export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS)
    redacted = redacted.replace(
      new RegExp(
        pattern.expression.source,
        `${pattern.expression.flags.replace("g", "")}g`,
      ),
      `[REDACTED:${pattern.name}]`,
    );
  return redacted;
}
export function evaluateFilePrivacy(
  file: Pick<SourceFile, "filename" | "patch">,
): PrivacyDecision {
  if (isMandatorySensitivePath(file.filename))
    return {
      allowed: false,
      reason: "sensitive_path",
      details:
        "Blocked by mandatory sensitive-path policy; user negation cannot override it.",
    };
  const match = file.patch ? inspectSensitiveContent(file.patch) : undefined;
  if (match)
    return {
      allowed: false,
      reason: "sensitive_content",
      details: `Blocked because the diff matched the ${match} heuristic. This bounded safety filter is not a universal secret-scanning guarantee.`,
    };
  return { allowed: true };
}
export async function assertContainedRegularFile(
  repositoryRoot: string,
  filename: string,
): Promise<number> {
  const root = await realpath(repositoryRoot);
  const candidate = resolve(root, filename);
  const rel = relative(root, candidate);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..\\`) ||
    rel.startsWith("../")
  )
    throw new Error(`Path escapes repository root: ${filename}`);
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink())
    throw new Error(`Symlink is not eligible for review: ${filename}`);
  const resolved = await realpath(candidate);
  const resolvedRel = relative(root, resolved);
  if (
    isAbsolute(resolvedRel) ||
    resolvedRel === ".." ||
    resolvedRel.startsWith(`..\\`) ||
    resolvedRel.startsWith("../")
  )
    throw new Error(`Resolved path escapes repository root: ${filename}`);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filename}`);
  return stat.size;
}

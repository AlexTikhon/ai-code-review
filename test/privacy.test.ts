import assert from "node:assert/strict";
import {
  evaluateFilePrivacy,
  inspectSensitiveContent,
  isMandatorySensitivePath,
} from "../src/privacy/policy.js";
import { isIgnoredPath, parseIgnoreFile } from "../src/review/ignore.js";
import { unitTest } from "./helpers.js";
unitTest("mandatory privacy blocks env variants, keys and credentials", () => {
  for (const path of [
    ".env",
    ".env.local",
    "ops/private.pem",
    ".aws/credentials",
    "id_rsa",
  ])
    assert.equal(isMandatorySensitivePath(path), true, path);
});
unitTest("sensitive content is blocked in reviewable source", () => {
  const decision = evaluateFilePrivacy({
    filename: "src/config.ts",
    patch: "+const token = 'abcdefghijklmnop123456';",
  });
  assert.equal(decision.reason, "sensitive_content");
  assert.equal(
    inspectSensitiveContent("-----BEGIN PRIVATE KEY-----"),
    "private key",
  );
});
unitTest(
  "gitignore matching covers root directories, globstars and descendants",
  () => {
    const rules = parseIgnoreFile("/private/\n**/*.snap\nnode_modules/\n");
    assert.equal(isIgnoredPath("private/a.ts", rules), true);
    assert.equal(isIgnoredPath("src/a.snap", rules), true);
    assert.equal(isIgnoredPath("packages/x/node_modules/a.js", rules), true);
  },
);
unitTest("user re-inclusion does not affect mandatory privacy policy", () => {
  const rules = parseIgnoreFile("*\n!.env\n");
  assert.equal(isIgnoredPath(".env", rules), false);
  assert.equal(evaluateFilePrivacy({ filename: ".env" }).allowed, false);
});

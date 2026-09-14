import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/args.js";
import { unitTest } from "./helpers.js";
unitTest("parseArgs parses strict PR and local modes", () => {
  const pr = parseArgs(["openai", "repo", "42", "--format", "json"]);
  assert.equal(pr.reviewMode, "pr");
  assert.equal(pr.pullNumber, 42);
  assert.equal(pr.format, "json");
  const local = parseArgs(["--local", "--base", "main", "--repo", "C:\\repo"]);
  assert.equal(local.reviewMode, "local");
  assert.equal(local.localBaseRef, "main");
});
unitTest("parseArgs rejects missing/flag values, unknown and conflicts", () => {
  assert.throws(
    () => parseArgs(["--local", "--base", "--repo", "x"]),
    /--base requires a value/,
  );
  assert.throws(() => parseArgs(["--local", "--wat"]), /Unknown option/);
  assert.throws(() => parseArgs(["owner", "repo", "1", "--local"]), /conflict/);
  assert.throws(() => parseArgs(["owner", "repo", "1", "extra"]), /Expected/);
});
unitTest("parseArgs requires positive finite integer PR numbers", () => {
  for (const value of ["abc", "Infinity", "0", "-1", "1.5"])
    assert.throws(
      () => parseArgs(["o", "r", value]),
      /positive finite integer/,
    );
});

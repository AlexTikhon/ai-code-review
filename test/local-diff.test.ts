import assert from "node:assert/strict";
import {
  countLines,
  countPatchStats,
  isProbablyBinary,
  parseNameStatus,
  parseNameStatusZ,
} from "../src/review-sources/local/local.js";
import { unitTest } from "./helpers.js";

unitTest(
  "parseNameStatus parses added modified deleted and renamed files",
  () => {
    const output = [
      "A\tsrc/new.ts",
      "M\tsrc/app.ts",
      "D\tsrc/old.ts",
      "R100\tsrc/was.ts\tsrc/now.ts",
    ].join("\n");

    assert.deepEqual(parseNameStatus(output), [
      { status: "added", filename: "src/new.ts" },
      { status: "modified", filename: "src/app.ts" },
      { status: "removed", filename: "src/old.ts" },
      {
        status: "renamed",
        previousFilename: "src/was.ts",
        filename: "src/now.ts",
      },
    ]);
  },
);

unitTest("countLines counts CRLF and LF consistently", () => {
  assert.equal(countLines("one\r\ntwo\nthree"), 3);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines(""), 0);
});

unitTest("parseNameStatusZ preserves whitespace and Unicode filenames", () => {
  assert.deepEqual(
    parseNameStatusZ(
      "A\0src/hello world-ą.ts\0R100\0old\tname.ts\0new name.ts\0",
    ),
    [
      { status: "added", filename: "src/hello world-ą.ts" },
      {
        status: "renamed",
        previousFilename: "old\tname.ts",
        filename: "new name.ts",
      },
    ],
  );
});

unitTest(
  "countPatchStats ignores headers and counts additions and deletions",
  () => {
    const patch = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      "-before",
      "+after",
      " unchanged",
      "+added",
    ].join("\n");

    assert.deepEqual(countPatchStats(patch), {
      additions: 2,
      deletions: 1,
      changes: 3,
    });
  },
);

unitTest(
  "isProbablyBinary detects null bytes and suspicious control characters",
  () => {
    assert.equal(isProbablyBinary(Buffer.from([0x00, 0x41])), true);
    assert.equal(
      isProbablyBinary(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x41])),
      true,
    );
    assert.equal(isProbablyBinary(Buffer.from("plain text", "utf8")), false);
  },
);

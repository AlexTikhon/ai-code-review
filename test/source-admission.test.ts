import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  evaluateFilePrivacy,
  isMandatorySensitivePath,
} from "../src/privacy/policy.js";
import { checkpointPath } from "../src/retrieval/embedding-checkpoint.js";
import {
  refreshRepositoryIndex,
  readIndex,
  indexPath,
} from "../src/retrieval/index-store.js";
import { DeterministicTestEmbedding } from "../src/retrieval/embeddings.js";
import type { EmbeddingAdapter } from "../src/retrieval/embeddings.js";
import { isGeneratedOrVendorPath } from "../src/review/file-classifier.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewRunRequest } from "../src/review/pipeline/types.js";
import { getLocalDiff } from "../src/review-sources/local/local.js";
import { refInputHash } from "../src/retrieval/vector-store.js";
import type { ReviewModel } from "../src/model/types.js";
import type { ReviewResult } from "../src/review/types.js";
import {
  cleanResult,
  filenameOf,
  makeSource,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { unitTest } from "./helpers.js";
import { isIgnoredPath, loadIgnorePolicy } from "../src/review/ignore.js";
import { indexOptions, put, repo } from "./index-harness.js";

const run = promisify(execFile);
const git = (root: string, args: string[]) => run("git", args, { cwd: root });
/** Synthetic private text only; no real credential file is ever read. */
const PRIVATE = "INTERNAL_CLIENT_ACME = 42";
const PRIVATE_FILE = `export const lookupAcmeClient = "${PRIVATE}";\n`;
const OK_FILE = "export function ok() { return 1; }\n";

async function committed(files: Record<string, string>): Promise<string> {
  const root = await repo(files);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

/** A repo whose protected `.env` was renamed (staged) to an ordinary source name. */
async function renamedEnvRepo(): Promise<string> {
  const root = await committed({
    ".env": PRIVATE_FILE,
    "src/ok.ts": OK_FILE,
    "src/helper.ts": "export function helper() { return 2; }\n",
  });
  await git(root, ["mv", ".env", "renamed.ts"]);
  await put(
    root,
    "src/ok.ts",
    "export function ok() { return lookupAcmeClient(); }\n",
  );
  return root;
}

function recorders() {
  const prompts: string[] = [];
  const reviewed: string[] = [];
  const model: ReviewModel = {
    provider: "test",
    async review(request) {
      prompts.push(request.system, request.user);
      reviewed.push(filenameOf(request.user));
      return cleanResult();
    },
  };
  const texts: string[] = [];
  const delegate = new DeterministicTestEmbedding();
  const embedding: EmbeddingAdapter = {
    provider: "fake",
    model: delegate.model,
    version: delegate.version,
    dimensions: delegate.dimensions,
    async embed(batch) {
      texts.push(...batch);
      return delegate.embed(batch);
    },
  };
  return { prompts, reviewed, model, texts, embedding };
}

const localRequest = (
  root: string,
  extra: Partial<ReviewRunRequest> = {},
): ReviewRunRequest => ({
  target: { kind: "local", localRepoPath: root },
  contextMode: "hybrid",
  dryRun: false,
  indexOnly: false,
  ...extra,
});
const config = { ...testConfig, maxRequests: 50 };
const skippedReason = (result: ReviewResult, filename: string) =>
  result.skippedFiles.find((file) => file.filename === filename)?.reason;

/* ---- original and destination paths ---- */

unitTest("privacy evaluation checks the rename or copy origin", () => {
  for (const previousFilename of [".env", "keys/server.pem", ".ssh/config"])
    assert.equal(
      evaluateFilePrivacy({ filename: "renamed.ts", previousFilename }).reason,
      "sensitive_path",
      previousFilename,
    );
  assert.equal(
    evaluateFilePrivacy({ filename: "b.ts", previousFilename: "a.ts" }).allowed,
    true,
  );
  assert.equal(isMandatorySensitivePath("renamed.ts"), false);
});

unitTest(
  "a local rename from a protected path is rejected before its patch is read",
  async () => {
    const root = await renamedEnvRepo();
    const control = await getLocalDiff(undefined, root);
    assert.match(
      control.files.find((file) => file.filename === "renamed.ts")?.patch ?? "",
      /INTERNAL_CLIENT_ACME/,
      "without an admission check the private bytes are collected",
    );

    const asked: string[] = [];
    const source = await getLocalDiff(undefined, root, {
      pathAllowed: (path) => {
        asked.push(path);
        return !isMandatorySensitivePath(path);
      },
    });
    const renamed = source.files.find((file) => file.filename === "renamed.ts");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.previousFilename, ".env", "provenance is preserved");
    assert.equal(renamed?.patch, undefined);
    assert.equal(renamed?.changes, 0);
    assert.ok(asked.includes(".env"), "the origin was consulted");
    assert.ok(!JSON.stringify(source).includes("INTERNAL_CLIENT_ACME"));
    assert.ok(
      source.files.find((file) => file.filename === "src/ok.ts")?.patch,
      "an ordinary sibling is still collected",
    );
  },
);

unitTest(
  "the local pipeline skips a protected rename and still reviews its sibling",
  async () => {
    const root = await renamedEnvRepo();
    const probe = recorders();
    const result = await executeReviewPipeline(
      localRequest(root, { contextMode: "diff" }),
      config,
      { model: probe.model },
    );
    assert.deepEqual(probe.reviewed, ["src/ok.ts"]);
    assert.equal(skippedReason(result, "renamed.ts"), "sensitive_path");
    assert.equal(result.coverage.skipped, 1);
    assert.equal(result.coverage.reviewed, 1);
    assert.equal(result.status, "complete");
    assert.ok(!JSON.stringify([result, probe.prompts]).includes(PRIVATE));
  },
);

unitTest(
  "a trusted ignore on the origin blocks a rename; head-side negation cannot relax it",
  async () => {
    const files = [
      {
        ...sourceFile("renamed.ts", `@@ -0,0 +1 @@\n+${PRIVATE}`),
        status: "renamed",
        previousFilename: ".env",
      },
      {
        ...sourceFile("copy.ts", `@@ -0,0 +1 @@\n+${PRIVATE}`),
        status: "copied",
        previousFilename: "keys/server.pem",
      },
      {
        ...sourceFile("moved.ts", `@@ -0,0 +1 @@\n+${PRIVATE}`),
        status: "renamed",
        previousFilename: "private/old.ts",
      },
      {
        ...sourceFile("settled.ts"),
        status: "renamed",
        previousFilename: "src/was.ts",
      },
      sourceFile("src/ok.ts"),
      // The proposed head tries to un-ignore everything; it is ordinary input.
      sourceFile(".ai-reviewer-ignore", "@@ -0,0 +1 @@\n+!private/\n+!.env"),
    ];
    const probe = recorders();
    const result = await executeReviewPipeline(
      { ...localRequest("unused"), contextMode: "diff" },
      config,
      {
        model: probe.model,
        source: makeSource(files, {
          mode: "pr",
          trustedIgnoreContents: "private/\n",
        }),
      },
    );
    assert.deepEqual(probe.reviewed.sort(), ["settled.ts", "src/ok.ts"]);
    assert.equal(skippedReason(result, "renamed.ts"), "sensitive_path");
    assert.equal(skippedReason(result, "copy.ts"), "sensitive_path");
    assert.equal(skippedReason(result, "moved.ts"), "ignored_by_user");
    assert.ok(!JSON.stringify([result, probe.prompts]).includes(PRIVATE));
  },
);

unitTest(
  "the destination of a protected rename never reaches embeddings, the index or prompts",
  async () => {
    const root = await renamedEnvRepo();
    const probe = recorders();
    const result = await executeReviewPipeline(localRequest(root), config, {
      model: probe.model,
      embedding: probe.embedding,
      embeddingExecution: { sleep: async () => undefined },
    });
    assert.equal(result.context.state, "used");
    assert.deepEqual(probe.reviewed, ["src/ok.ts"], "safe code is reviewed");
    assert.ok(probe.texts.length > 0, "hybrid indexing really embedded");
    const everything = JSON.stringify([probe.texts, probe.prompts, result]);
    assert.ok(!everything.includes("INTERNAL_CLIENT_ACME"));
    assert.ok(!everything.includes("lookupAcmeClient = "));
    const stored = await readIndex(indexPath(root, config.cacheDirName));
    assert.equal(stored.status, "valid");
    if (stored.status === "valid") {
      const paths = new Set(stored.index.chunks.map((chunk) => chunk.path));
      assert.ok(paths.has("src/helper.ts"));
      assert.ok(!paths.has("renamed.ts"));
    }
  },
);

unitTest(
  "a protected rename supplied by an injected source is also kept out of the index",
  async () => {
    const root = await renamedEnvRepo();
    const probe = recorders();
    const result = await executeReviewPipeline(localRequest(root), config, {
      model: probe.model,
      embedding: probe.embedding,
      embeddingExecution: { sleep: async () => undefined },
      source: makeSource(
        [
          sourceFile("src/ok.ts", "@@ -0,0 +1 @@\n+lookupAcmeClient()"),
          {
            ...sourceFile("renamed.ts", `@@ -0,0 +1 @@\n+${PRIVATE}`),
            status: "renamed",
            previousFilename: ".env",
          },
        ],
        { repositoryRoot: root },
      ),
    });
    assert.deepEqual(probe.reviewed, ["src/ok.ts"]);
    assert.equal(skippedReason(result, "renamed.ts"), "sensitive_path");
    assert.ok(
      !JSON.stringify([probe.texts, probe.prompts, result]).includes(
        "INTERNAL_CLIENT_ACME",
      ),
    );
  },
);

unitTest(
  "dry-run and index-only apply the same admission decisions",
  async () => {
    const root = await renamedEnvRepo();
    const dry = recorders();
    const dryRun = await executeReviewPipeline(
      localRequest(root, { dryRun: true }),
      config,
      { model: dry.model, embedding: dry.embedding },
    );
    assert.equal(dry.reviewed.length, 0, "dry-run makes no model call");
    assert.equal(dry.texts.length, 0, "dry-run makes no embedding call");
    assert.deepEqual(
      dryRun.dryRun?.proposedFiles.map((file) => file.filename),
      ["src/ok.ts"],
    );
    assert.equal(skippedReason(dryRun, "renamed.ts"), "sensitive_path");
    assert.ok(!JSON.stringify(dryRun).includes("INTERNAL_CLIENT_ACME"));

    const only = recorders();
    const indexed = await executeReviewPipeline(
      localRequest(root, { indexOnly: true }),
      config,
      {
        embedding: only.embedding,
        embeddingExecution: { sleep: async () => undefined },
      },
    );
    assert.equal(only.reviewed.length, 0);
    assert.ok(only.texts.length > 0);
    assert.ok(
      !JSON.stringify([only.texts, indexed]).includes("INTERNAL_CLIENT"),
    );
  },
);

/* ---- cached indexes ---- */

unitTest(
  "a cached index never returns chunks or vectors of a now-protected rename",
  async () => {
    const root = await renamedEnvRepo();
    const first = recorders();
    // Run 1: no provenance is known, so renamed.ts is ordinary context.
    await executeReviewPipeline(localRequest(root), config, {
      model: first.model,
      embedding: first.embedding,
      embeddingExecution: { sleep: async () => undefined },
      source: makeSource(
        [sourceFile("src/ok.ts", "@@ -0,0 +1 @@\n+lookupAcmeClient()")],
        { repositoryRoot: root },
      ),
    });
    const before = await readIndex(indexPath(root, config.cacheDirName));
    assert.equal(before.status, "valid");
    assert.ok(
      before.status === "valid" &&
        before.index.chunks.some((chunk) => chunk.path === "renamed.ts"),
      "control: the unprotected file was indexed and embedded",
    );
    assert.ok(
      first.texts.some((text) => text.includes("INTERNAL_CLIENT_ACME")),
    );
    const vectorsBefore =
      before.status === "valid" ? before.index.vectors.count : 0;

    // Run 2: the same change now arrives with its protected origin.
    const second = recorders();
    const result = await executeReviewPipeline(localRequest(root), config, {
      model: second.model,
      embedding: second.embedding,
      embeddingExecution: { sleep: async () => undefined },
      source: makeSource(
        [
          sourceFile("src/ok.ts", "@@ -0,0 +1 @@\n+lookupAcmeClient()"),
          {
            ...sourceFile("renamed.ts", `@@ -0,0 +1 @@\n+${PRIVATE}`),
            status: "renamed",
            previousFilename: ".env",
          },
        ],
        { repositoryRoot: root, snapshotId: "snap-2" },
      ),
    });
    assert.ok(
      !JSON.stringify([second.texts, second.prompts, result.context]).includes(
        "INTERNAL_CLIENT_ACME",
      ),
    );
    assert.ok(
      second.texts.length <= 1,
      "every index vector was reused; at most the retrieval query is embedded",
    );
    const after = await readIndex(indexPath(root, config.cacheDirName));
    assert.equal(after.status, "valid");
    if (after.status !== "valid") return;
    assert.ok(after.index.chunks.every((chunk) => chunk.path !== "renamed.ts"));
    assert.ok(after.index.files.every((file) => file.path !== "renamed.ts"));
    assert.ok(after.index.vectors.count < vectorsBefore);
    const wanted = new Set(after.index.inputHashes);
    for (const ref of after.index.vectors.refs())
      assert.ok(wanted.has(refInputHash(ref)), "no orphan vector survives");
    assert.ok(
      !(await readFile(indexPath(root, config.cacheDirName), "utf8")).includes(
        "renamed.ts",
      ),
    );
  },
);

unitTest(
  "an embedding checkpoint cannot resurrect a path that is no longer admitted",
  async () => {
    const root = await committed({
      "src/ok.ts": OK_FILE,
      "renamed.ts": PRIVATE_FILE,
    });
    const delegate = new DeterministicTestEmbedding();
    const identity = {
      provider: "fake",
      model: delegate.model,
      version: delegate.version,
      dimensions: delegate.dimensions,
    };
    // Batch size 1, files in path order: renamed.ts is paid for, src/ok.ts fails.
    let calls = 0;
    const flaky: EmbeddingAdapter = {
      ...identity,
      async embed(texts) {
        if (++calls === 2) throw new Error("provider down");
        return delegate.embed(texts);
      },
    };
    await assert.rejects(
      refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: flaky,
          maxEmbeddingBatchSize: 1,
          embeddingExecution: {
            policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
            sleep: async () => undefined,
          },
        }),
      ),
    );
    const checkpoint = JSON.parse(
      await readFile(checkpointPath(root, ".cache"), "utf8"),
    ) as { vectors: object };
    assert.equal(
      Object.keys(checkpoint.vectors).length,
      1,
      "the private file's vector was paid for and checkpointed",
    );

    const embedded: string[] = [];
    const clean: EmbeddingAdapter = {
      ...identity,
      async embed(texts) {
        embedded.push(...texts);
        return delegate.embed(texts);
      },
    };
    const { index } = await refreshRepositoryIndex(
      await indexOptions(root, {
        embedding: clean,
        maxEmbeddingBatchSize: 1,
        excludePaths: new Set(["renamed.ts"]),
      }),
    );
    assert.ok(index.chunks.every((chunk) => chunk.path !== "renamed.ts"));
    assert.ok(!JSON.stringify(embedded).includes("INTERNAL_CLIENT_ACME"));
    const wanted = new Set(index.inputHashes);
    for (const ref of index.vectors.refs())
      assert.ok(wanted.has(refInputHash(ref)));
  },
);

/* ---- generated and vendor context ---- */

unitTest("generated and vendor rules match path components only", () => {
  for (const path of [
    "dist/artifact.js",
    "node_modules/vendor.js",
    "packages/a/node_modules/dep/index.js",
    "vendor/lib.go",
    "lib/vendor/x.ts",
    "build/out.ts",
    "coverage/lcov.ts",
    ".next/server.js",
    "src/app.min.js",
    "web\\dist\\bundle.js",
  ])
    assert.equal(isGeneratedOrVendorPath(path), true, path);
  for (const path of [
    "src/node_modules-helper.ts",
    "src/distribution.ts",
    "src/dist.ts",
    "src/vendors.ts",
    "src/vendorize.ts",
    "src/build-info.ts",
    "src/rebuild/index.ts",
    "src/coverage-report.ts",
    "src/minimal.ts",
    "src/app.ts",
  ])
    assert.equal(isGeneratedOrVendorPath(path), false, path);
});

const TREE: Record<string, string> = {
  "src/app.ts": "export function app() { return 1; }\n",
  "src/node_modules-helper.ts": "export const helperName = 'node_modules';\n",
  "src/distribution.ts": "export const distribution = 'dist';\n",
  "src/vendorize.ts": "export const vendorize = true;\n",
  "dist/artifact.js": "export const GENERATED_MARKER = 'dist';\n",
  "node_modules/vendor.js": "export const VENDOR_MARKER = 'nm';\n",
  "packages/a/node_modules/dep.js": "export const NESTED_VENDOR_MARKER = 1;\n",
  "vendor/lib.go": "package vendor\nvar VENDOR_GO_MARKER = 1\n",
  "build/out.ts": "export const BUILD_MARKER = 1;\n",
  "src/app.min.js": "export const MIN_MARKER = 1;\n",
};
const ALLOWED = [
  "src/app.ts",
  "src/distribution.ts",
  "src/node_modules-helper.ts",
  "src/vendorize.ts",
];

unitTest(
  "tracked generated and vendor files are excluded before reads and embeddings in both modes",
  async () => {
    const root = await committed(TREE);
    for (const gitRevision of [undefined, "HEAD"]) {
      const probe = recorders();
      const { index, stats } = await refreshRepositoryIndex(
        await indexOptions(root, {
          embedding: probe.embedding,
          gitRevision,
          cacheDirName: `.cache-${gitRevision ?? "tree"}`,
        }),
      );
      const label = gitRevision ?? "working tree";
      assert.deepEqual(
        index.files.map((file) => file.path).sort(),
        ALLOWED,
        label,
      );
      assert.equal(stats.filesRead, ALLOWED.length, `${label}: reads`);
      assert.ok(!/_MARKER/.test(JSON.stringify(probe.texts)), label);
    }
  },
);

unitTest(
  "a trusted ignore adds exclusions but its negations cannot re-admit mandatory or generated paths",
  async () => {
    const root = await committed({
      ...TREE,
      "src/private/notes.ts": "export const privateNotes = 1;\n",
      "src/.env.ts": "export const ENV_MARKER = 1;\n",
      "src/config.ts": "export const config = 1;\n",
      // Ignore everything, then try to bring the dangerous paths back.
      ".ai-reviewer-ignore": [
        "*",
        "!*/",
        "!src/app.ts",
        "!src/config.ts",
        "!dist/artifact.js",
        "!node_modules/vendor.js",
        "!src/.env.ts",
        "",
      ].join("\n"),
    });
    const policy = await loadIgnorePolicy(root);
    for (const readmitted of [
      "src/app.ts",
      "dist/artifact.js",
      "node_modules/vendor.js",
      "src/.env.ts",
    ])
      assert.equal(isIgnoredPath(readmitted, policy), false, readmitted);
    assert.equal(isIgnoredPath("src/private/notes.ts", policy), true);
    for (const gitRevision of [undefined, "HEAD"]) {
      const { index } = await refreshRepositoryIndex(
        await indexOptions(root, {
          gitRevision,
          cacheDirName: `.cache-precedence-${gitRevision ?? "tree"}`,
        }),
      );
      assert.deepEqual(
        index.files.map((file) => file.path).sort(),
        ["src/app.ts", "src/config.ts"],
        gitRevision ?? "working tree",
      );
    }
  },
);

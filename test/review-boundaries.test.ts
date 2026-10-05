import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { cacheDirectory } from "../src/cache/paths.js";
import { withPublicationLock } from "../src/cache/publication-lock.js";
import {
  readReviewCache,
  reviewCacheKey,
  writeReviewCache,
} from "../src/cache/review-cache.js";
import { assembleReviewPrompt } from "../src/prompts/review.js";
import { getGithubReviewSource } from "../src/review-sources/github/pulls.js";
import type { GithubRequester } from "../src/review-sources/github/client.js";
import {
  countPatchStats,
  getLocalDiff,
} from "../src/review-sources/local/local.js";
import { validateFindings } from "../src/review/findings.js";
import { splitPatchForReview } from "../src/review/patch.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import { rawEvidenceSchema } from "../src/schemas/review.schema.js";
import {
  nodeFileOps,
  persistedRefsOf,
  publishIndex,
} from "../src/retrieval/index-generation.js";
import { indexPath, readIndex } from "../src/retrieval/index-store.js";
import { unitTest } from "./helpers.js";
import {
  cleanResult,
  deferred,
  findingResult,
  makeSource,
  request,
  sourceFile,
  testConfig,
} from "./fixtures.js";
import { repo, put } from "./index-harness.js";
import { syntheticIndex, indexSignature } from "./index-fixtures.js";

const temporary = () => mkdtemp(join(tmpdir(), "acr-boundaries-"));

unitTest(
  "repository-planted clean results and cache junctions are never consulted",
  async () => {
    const root = await temporary();
    const outside = await temporary();
    await symlink(
      outside,
      join(root, ".ai-reviewer"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = { ...testConfig, cacheDirName: ".ai-reviewer/cache" };
    const source = makeSource([sourceFile("a.ts")], { repositoryRoot: root });
    const segment = splitPatchForReview(
      source.files[0]!.patch!,
      config.maxPatchTokens,
      config.maxSegmentsPerFile,
    )[0]!;
    const prompt = assembleReviewPrompt({
      title: source.title,
      description: source.description,
      filename: "a.ts",
      fileType: "source",
      segment,
      contexts: [],
      maxInputTokens: config.maxInputTokens,
      outputReservation: config.maxOutputTokens,
      maxMetadataCharacters: config.maxMetadataCharacters,
      maxContextTokens: config.maxContextTokens,
    });
    let calls = 0;
    const model = {
      provider: "synthetic",
      identity: "v1",
      async review() {
        calls++;
        return findingResult("a.ts");
      },
    };
    const key = reviewCacheKey(
      {
        system: prompt.system,
        user: prompt.user,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
      },
      model,
    );
    await mkdir(join(outside, "cache", "reviews"), { recursive: true });
    const planted = join(outside, "cache", "reviews", `${key}.json`);
    await writeFile(planted, JSON.stringify(cleanResult()));
    const before = await readFile(planted, "utf8");
    const result = await executeReviewPipeline(request, config, {
      model,
      source,
    });
    assert.equal(calls, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.usage.cacheHits, 0);
    assert.equal(await readFile(planted, "utf8"), before);
    assert.deepEqual(await readdir(join(outside, "cache", "reviews")), [
      `${key}.json`,
    ]);
    assert.ok(
      relative(root, cacheDirectory(root, config.cacheDirName)).startsWith(
        "..",
      ),
    );
    assert.notEqual(
      cacheDirectory(root, ".cache"),
      cacheDirectory(outside, ".cache"),
    );
  },
);

unitTest(
  "a junction at the trusted cache namespace rejects reads and writes",
  async () => {
    const root = await temporary();
    const outside = await temporary();
    const directory = cacheDirectory(root, ".cache");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await symlink(
      outside,
      directory,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(await readReviewCache(root, ".cache", "entry"), undefined);
    await assert.rejects(
      writeReviewCache(root, ".cache", "entry", cleanResult()),
      /symlinks or junctions/,
    );
    assert.deepEqual(await readdir(outside), []);
  },
);

unitTest(
  "a cache-write failure retains findings and completed coverage",
  async () => {
    const root = await temporary();
    const directory = cacheDirectory(root, testConfig.cacheDirName);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await writeFile(directory, "not a cache directory");
    const events: string[] = [];
    const result = await executeReviewPipeline(request, testConfig, {
      source: makeSource([sourceFile("a.ts")], { repositoryRoot: root }),
      model: {
        provider: "synthetic",
        async review() {
          return findingResult("a.ts");
        },
      },
      events: (event) => events.push(event.message ?? ""),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.coverage.reviewed, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.usage.actualRequests, 1);
    assert.ok(events.some((message) => message.includes("cache write failed")));
  },
);

unitTest(
  "duplicate valid findings are deduplicated without invalid-evidence failure",
  async () => {
    const answer = findingResult("a.ts");
    answer.response.findings.push(
      structuredClone(answer.response.findings[0]!),
    );
    const result = await executeReviewPipeline(request, testConfig, {
      source: makeSource([sourceFile("a.ts")]),
      model: {
        provider: "synthetic",
        async review() {
          return answer;
        },
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.errors, []);
  },
);

unitTest(
  "huge evidence ranges are rejected without allocating or throwing",
  () => {
    const answer = findingResult("a.ts");
    const segment = splitPatchForReview("@@ -0,0 +1 @@\n+bug()", 500, 2)[0]!;
    for (const end of [4294967296, Number.MAX_SAFE_INTEGER]) {
      answer.response.findings[0]!.evidence[0]!.endLine = end;
      assert.deepEqual(
        validateFindings(answer.response, "a.ts", segment, []),
        [],
      );
    }
    assert.equal(
      rawEvidenceSchema.safeParse({
        path: "a.ts",
        startLine: 1,
        endLine: Number.MAX_SAFE_INTEGER + 1,
      }).success,
      false,
    );
  },
);

unitTest(
  "real Git increment and decrement hunks retain old/new line coordinates",
  async () => {
    const root = await repo({ "a.ts": "++old;\n--old;\nnext();\n" });
    await promisify(execFile)("git", ["add", "a.ts"], { cwd: root });
    await promisify(execFile)("git", ["commit", "-m", "fixture"], {
      cwd: root,
    });
    await put(root, "a.ts", "++updated;\n--updated;\nnext();\n");
    const source = await getLocalDiff(undefined, root);
    const segment = splitPatchForReview(source.files[0]!.patch!, 2000, 2)[0]!;
    assert.deepEqual(
      countPatchStats(
        "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n--- old;\n+++ updated;",
      ),
      { additions: 1, deletions: 1, changes: 2 },
    );
    assert.deepEqual(
      segment.lineMappings
        .filter((line) => line.kind === "addition")
        .map((line) => line.newLine),
      [1, 2],
    );
    assert.deepEqual(
      segment.lineMappings
        .filter((line) => line.kind === "deletion")
        .map((line) => line.oldLine),
      [1, 2],
    );
    assert.equal(
      segment.lineMappings.find((line) => line.kind === "context")?.newLine,
      3,
    );
    assert.equal(
      validateFindings(findingResult("a.ts", 2).response, "a.ts", segment, [])
        .length,
      1,
    );
  },
);

unitTest(
  "publication locking works across processes and recovers a terminated owner",
  async () => {
    const root = await temporary();
    const path = indexPath(root, ".cache");
    const url = new URL("../src/cache/publication-lock.js", import.meta.url)
      .href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { withPublicationLock } from ${JSON.stringify(url)};
    await withPublicationLock(${JSON.stringify(path)}, async () => {
      process.send('locked');
      await new Promise(resolve => process.on('message', resolve));
    });
    process.disconnect();
  `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let diagnostics = "";
    child.stderr!.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    const held = deferred();
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        held.reject(error);
        reject(error);
      });
      child.on("exit", () => {
        held.reject(new Error(`lock owner exited: ${diagnostics}`));
        resolve();
      });
    });
    child.on("message", (message) => {
      if (message === "locked") held.resolve();
    });
    try {
      await held.promise;
      const before = await readFile(`${path}.lock`, "utf8");
      const cancellation = new AbortController();
      const blocked = withPublicationLock(
        path,
        async () => {
          assert.fail("must not enter while another process holds the lock");
        },
        cancellation.signal,
      );
      setTimeout(() => cancellation.abort(), 50);
      await assert.rejects(
        blocked,
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(await readFile(`${path}.lock`, "utf8"), before);
      child.kill();
      await exited;
      await publishIndex({
        manifestPath: path,
        index: syntheticIndex({ count: 2 }),
      });
      assert.equal((await readIndex(path)).status, "valid");
      assert.deepEqual((await readdir(dirname(path))).sort(), [
        "repository-index.generations",
        "repository-index.json",
      ]);
    } finally {
      child.kill();
      await exited;
    }
  },
);

unitTest(
  "PR collection rejects changed head/base/count and duplicate paginated files",
  async () => {
    for (const change of ["head", "base", "count", "duplicate", "none"]) {
      let metadataCalls = 0;
      const requester: GithubRequester = async <T>(path: string) => {
        if (path.includes("/contents/"))
          return { encoding: "base64", content: "" } as T;
        if (path.includes("/files?"))
          return [
            sourceFile("a.ts"),
            sourceFile(change === "duplicate" ? "a.ts" : "b.ts"),
          ] as T;
        metadataCalls++;
        const final = metadataCalls === 2;
        return {
          title: "PR",
          body: "",
          changed_files: final && change === "count" ? 3 : 2,
          base: { sha: final && change === "base" ? "new-base" : "base" },
          head: { sha: final && change === "head" ? "new-head" : "head" },
        } as T;
      };
      const collected = getGithubReviewSource("o", "r", 1, requester);
      if (change === "none")
        assert.equal((await collected).headRevision, "head");
      else await assert.rejects(collected, /changed during collection/);
    }
  },
);

unitTest(
  "concurrent publishers cannot retire a blob checked by another publisher",
  async () => {
    const root = await temporary();
    const path = indexPath(root, ".cache");
    await publishIndex({
      manifestPath: path,
      index: syntheticIndex({ count: 2 }),
    });
    const first = await readIndex(path);
    const second = await readIndex(path);
    assert.equal(first.status, "valid");
    assert.equal(second.status, "valid");
    if (first.status !== "valid" || second.status !== "valid")
      throw new Error("fixture");
    const checked = deferred();
    const resume = deferred();
    const held = publishIndex({
      manifestPath: path,
      index: second.index,
      previous: persistedRefsOf(second.index),
      ops: {
        ...nodeFileOps,
        async stat(file) {
          const info = await nodeFileOps.stat(file);
          if (file.endsWith(".bin")) {
            checked.resolve();
            await resume.promise;
          }
          return info;
        },
      },
    });
    await checked.promise;
    let entered = false;
    const next = syntheticIndex({ count: 3 });
    const pending = publishIndex({
      manifestPath: path,
      index: next,
      previous: persistedRefsOf(first.index),
      ops: {
        ...nodeFileOps,
        async mkdir(directory) {
          entered = true;
          await nodeFileOps.mkdir(directory);
        },
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        entered,
        false,
        "second publisher must wait before touching generation files",
      );
    } finally {
      resume.resolve();
    }
    await held;
    await pending;
    const loaded = await readIndex(path);
    assert.equal(loaded.status, "valid");
    if (loaded.status === "valid")
      assert.equal(indexSignature(loaded.index), indexSignature(next));
  },
);

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ReviewEvent } from "../src/observability/events.js";
import {
  indexPath,
  readIndex,
  refreshRepositoryIndex,
  type IndexStoreEvent,
} from "../src/retrieval/index-store.js";
import {
  localRepositoryId,
  contextRepositoryId,
} from "../src/review/context-identity.js";
import { executeReviewPipeline } from "../src/review/pipeline/run-review-pipeline.js";
import type { ReviewRunRequest } from "../src/review/pipeline/types.js";
import type { EmbeddingAdapter } from "../src/retrieval/embeddings.js";
import {
  getLocalDiff,
  resolveRepositoryRoot,
} from "../src/review-sources/local/local.js";
import type { ReviewModel } from "../src/model/types.js";
import { cleanResult, testConfig } from "./fixtures.js";
import { routedFetch, TOKEN } from "./github-fakes.js";
import { unitTest } from "./helpers.js";
import {
  indexOptions,
  probedEmbedding,
  repo,
  sources,
} from "./index-harness.js";

const git = promisify(execFile);
const CACHE = ".cache-identity";
const config = { ...testConfig, cacheDirName: CACHE };

async function checkout(files = sources(3)) {
  const root = await repo(files);
  const run = (args: string[]) => git("git", args, { cwd: root });
  await run(["add", "-A"]);
  await run(["commit", "-m", "base"]);
  const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
  return { root, head, run };
}

function runPipeline(
  request: ReviewRunRequest,
  embedding: EmbeddingAdapter,
  github?: { head: string },
  model?: ReviewModel,
) {
  const events: ReviewEvent[] = [];
  const fetchImpl = github
    ? routedFetch((url) =>
        url.pathname.includes("/contents/")
          ? { status: 404, json: {} }
          : url.pathname.endsWith("/files")
            ? {
                json: [
                  {
                    filename: "src/m0.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 0,
                    changes: 1,
                    patch: "@@ -0,0 +1 @@\n+x",
                  },
                ],
              }
            : {
                json: {
                  title: "t",
                  body: "",
                  changed_files: 1,
                  base: { sha: github.head },
                  head: { sha: github.head },
                },
              },
      ).fetch
    : undefined;
  return executeReviewPipeline(request, config, {
    embedding,
    model,
    events: (event) => events.push(event),
    ...(fetchImpl ? { github: { token: TOKEN, fetch: fetchImpl } } : {}),
  }).then((result) => ({
    result,
    index: events.find((e) => e.stage === "index" && e.type === "complete")
      ?.data,
    events,
  }));
}
const local = (root: string): ReviewRunRequest => ({
  target: { kind: "local", localRepoPath: root },
  contextMode: "hybrid",
  dryRun: false,
  indexOnly: true,
});
const pr = (
  root: string,
  owner = "owner",
  repo = "repo",
): ReviewRunRequest => ({
  target: {
    kind: "pull-request",
    owner,
    repo,
    pullNumber: 1,
    localRepoPath: root,
  },
  contextMode: "hybrid",
  dryRun: false,
  indexOnly: true,
});

unitTest(
  "local identity is deterministic, per checkout and credential-free",
  async () => {
    const a = await checkout();
    const b = await checkout();
    const rootA = await resolveRepositoryRoot(a.root);
    const rootB = await resolveRepositoryRoot(b.root);
    assert.equal(localRepositoryId(rootA), localRepositoryId(rootA));
    assert.notEqual(localRepositoryId(rootA), localRepositoryId(rootB));
    assert.match(localRepositoryId(rootA), /^[a-f0-9]{64}$/);
    // No remote is consulted, so credentials in a remote URL cannot reach it.
    await a.run([
      "remote",
      "add",
      "origin",
      "https://user:secret@example.com/x.git",
    ]);
    assert.equal(localRepositoryId(rootA), localRepositoryId(rootA));
    const source = await getLocalDiff(undefined, a.root);
    assert.equal(source.repositoryId, localRepositoryId(rootA));
    assert.equal(contextRepositoryId(source), localRepositoryId(rootA));
    assert.doesNotMatch(JSON.stringify(source), /secret@/);
  },
);

unitTest(
  "a source without a local checkout falls back to its own identity",
  () => {
    assert.equal(
      contextRepositoryId({
        repositoryId: "eval/x",
      } as Parameters<typeof contextRepositoryId>[0]),
      "eval/x",
    );
  },
);

unitTest(
  "a local index is reused by a PR review of the same checkout, and back",
  async () => {
    const { root, head } = await checkout();
    const first = await runPipeline(local(root), probedEmbedding().adapter);
    assert.equal(first.index?.loaded, "missing");
    assert.ok(Number(first.index?.embeddingRequests) > 0);

    const probe = probedEmbedding();
    const second = await runPipeline(pr(root), probe.adapter, { head });
    assert.equal(second.index?.loaded, "valid");
    assert.equal(second.index?.previous, "reused");
    assert.equal(second.index?.embeddingRequests, 0);
    assert.equal(second.index?.vectorsCreated, 0);
    assert.ok(Number(second.index?.vectorsReused) > 0);
    assert.equal(probe.state.requests, 0);

    const back = probedEmbedding();
    const third = await runPipeline(local(root), back.adapter);
    assert.equal(third.index?.loaded, "valid");
    assert.equal(third.index?.previous, "reused");
    assert.equal(back.state.requests, 0);
  },
);

unitTest(
  "a full PR review retrieves from the checkout's index rather than rejecting it as another repository",
  async () => {
    const { root, head } = await checkout(sources(3));
    let requests = 0;
    const model: ReviewModel = {
      provider: "fake",
      async review() {
        requests++;
        return cleanResult();
      },
    };
    const { result } = await runPipeline(
      { ...pr(root), contextMode: "lexical", indexOnly: false },
      probedEmbedding().adapter,
      { head },
      model,
    );
    assert.equal(requests, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.status, "complete");
    assert.equal(result.context.state, "used");
  },
);

unitTest(
  "the PR's owner/repo, including a fork's, never changes index compatibility",
  async () => {
    const { root, head } = await checkout();
    await runPipeline(
      pr(root, "upstream", "project"),
      probedEmbedding().adapter,
      {
        head,
      },
    );
    const probe = probedEmbedding();
    const fork = await runPipeline(
      pr(root, "contributor", "project-fork"),
      probe.adapter,
      {
        head,
      },
    );
    assert.equal(fork.index?.loaded, "valid");
    assert.equal(fork.index?.previous, "reused");
    assert.equal(probe.state.requests, 0);
    // Reporting still names the pull request's own repository.
    assert.equal(fork.result.source?.repositoryId, "contributor/project-fork");
    assert.equal(fork.result.source?.headRevision, head);
    assert.equal(fork.result.source?.mode, "pr");
  },
);

unitTest(
  "checkouts of the same GitHub repository never share an index",
  async () => {
    const one = await checkout();
    const two = await checkout();
    assert.notEqual(
      indexPath(await resolveRepositoryRoot(one.root), CACHE),
      indexPath(await resolveRepositoryRoot(two.root), CACHE),
    );
    await runPipeline(pr(one.root), probedEmbedding().adapter, {
      head: one.head,
    });
    const probe = probedEmbedding();
    const other = await runPipeline(pr(two.root), probe.adapter, {
      head: two.head,
    });
    assert.equal(other.index?.loaded, "missing");
    assert.equal(other.index?.previous, "none");
    assert.ok(probe.state.requests > 0);
  },
);

unitTest(
  "another checkout's index copied into place is rejected, not reused",
  async () => {
    const one = await checkout();
    const three = await checkout();
    await runPipeline(pr(one.root), probedEmbedding().adapter, {
      head: one.head,
    });
    const from = dirname(
      indexPath(await resolveRepositoryRoot(one.root), CACHE),
    );
    const to = dirname(
      indexPath(await resolveRepositoryRoot(three.root), CACHE),
    );
    await cp(from, to, { recursive: true });
    const probe = probedEmbedding();
    const copied = await runPipeline(pr(three.root), probe.adapter, {
      head: three.head,
    });
    assert.equal(copied.index?.loaded, "incompatible");
    assert.ok(probe.state.requests > 0);
    assert.match(
      copied.result.context.message ?? "",
      /repository identity differs/,
    );
  },
);

unitTest("a worktree is its own checkout with its own index", async () => {
  const main = await checkout();
  const parent = await mkdtemp(join(tmpdir(), "acr-worktree-"));
  const tree = join(parent, "wt");
  await main.run(["worktree", "add", tree, "-b", "feature"]);
  const rootMain = await resolveRepositoryRoot(main.root);
  const rootTree = await resolveRepositoryRoot(tree);
  assert.notEqual(rootMain, rootTree);
  // They share an object database, but working-tree content is per checkout.
  assert.notEqual(localRepositoryId(rootMain), localRepositoryId(rootTree));
  assert.notEqual(indexPath(rootMain, CACHE), indexPath(rootTree, CACHE));
  await runPipeline(local(main.root), probedEmbedding().adapter);
  const probe = probedEmbedding();
  const other = await runPipeline(local(tree), probe.adapter);
  assert.equal(other.index?.loaded, "missing");
});

unitTest(
  "an index made under a source-scoped owner/repo identity is adopted without re-embedding",
  async () => {
    const root = await repo(sources(4));
    const legacy = probedEmbedding();
    await refreshRepositoryIndex(
      await indexOptions(root, {
        repositoryId: "owner/repo",
        embedding: legacy.adapter,
        cacheDirName: CACHE,
      }),
    );
    assert.ok(legacy.state.requests > 0);

    const probe = probedEmbedding();
    const events: IndexStoreEvent[] = [];
    const localId = localRepositoryId(await resolveRepositoryRoot(root));
    const refreshed = await refreshRepositoryIndex(
      await indexOptions(root, {
        repositoryId: localId,
        embedding: probe.adapter,
        cacheDirName: CACHE,
        onStoreEvent: (event) => events.push(event),
      }),
    );
    assert.equal(refreshed.loaded, "valid");
    assert.equal(refreshed.stats.previous, "reused");
    assert.equal(refreshed.stats.vectorsCreated, 0);
    assert.equal(refreshed.stats.embeddingRequests, 0);
    assert.equal(probe.state.requests, 0);
    assert.equal(refreshed.index.repositoryId, localId);
    assert.ok(refreshed.index.chunks.every((c) => c.repositoryId === localId));
    assert.ok(events.some((event) => event.type === "identity_migrated"));

    // The adopted index is what is on disk now: no second migration.
    const persisted = await readIndex(indexPath(root, CACHE), {
      repositoryId: localId,
    });
    assert.equal(persisted.status, "valid");
    const again = await refreshRepositoryIndex(
      await indexOptions(root, {
        repositoryId: localId,
        embedding: probe.adapter,
        cacheDirName: CACHE,
        onStoreEvent: (event) => events.push(event),
      }),
    );
    assert.equal(again.stats.previous, "reused");
    assert.equal(
      events.filter((event) => event.type === "identity_migrated").length,
      1,
    );
  },
);

unitTest("an index with another local identity is never adopted", async () => {
  const root = await repo(sources(3));
  await refreshRepositoryIndex(
    await indexOptions(root, {
      repositoryId: "f".repeat(64),
      embedding: probedEmbedding().adapter,
      cacheDirName: CACHE,
    }),
  );
  const probe = probedEmbedding();
  const refreshed = await refreshRepositoryIndex(
    await indexOptions(root, {
      repositoryId: "a".repeat(64),
      embedding: probe.adapter,
      cacheDirName: CACHE,
    }),
  );
  assert.equal(refreshed.loaded, "incompatible");
  assert.ok(probe.state.requests > 0);
});

unitTest(
  "reports expose the source's own identity and no internal context identity",
  async () => {
    const { root, head } = await checkout();
    const result = (
      await runPipeline(pr(root), probedEmbedding().adapter, { head })
    ).result;
    assert.equal(result.source?.repositoryId, "owner/repo");
    assert.equal(result.source?.baseRevision, head);
    assert.equal(result.source?.snapshotId.length, 64);
    assert.equal("contextIdentity" in (result.source ?? {}), false);
    const localResult = (
      await runPipeline(local(root), probedEmbedding().adapter)
    ).result;
    assert.equal("contextIdentity" in (localResult.source ?? {}), false);
    assert.doesNotMatch(
      JSON.stringify(result.source),
      new RegExp(localRepositoryId(await resolveRepositoryRoot(root))),
    );
  },
);

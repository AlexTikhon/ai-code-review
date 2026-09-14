# Architecture decisions

## Orchestration

The original four useful stages remain, but LangGraph was removed. The pipeline is linear, has no checkpoint/resume or conditional graph behavior, and the framework made dependency injection, fatal short-circuiting, and one retry budget harder to see. `createReviewerGraph()` remains as a compatibility facade over the explicit pipeline. This also removed the advisory-bearing LangChain/LangSmith transitive tree without a major-version migration.

Console rendering is a CLI event consumer. Domain and retrieval modules emit structured events containing run ID, stage, timing/attempt fields, revision/snapshot coverage, and usage—not raw code or prompts.

## Model boundary

`ReviewModel` and `EmbeddingAdapter` are injected interfaces. Production OpenAI adapters use structured JSON; offline tests use deterministic adapters. Trusted review rules are a system message. Metadata, code, comments, diffs, and retrieved chunks are clearly labeled untrusted user data. Prompt/schema/policy versions participate in cache keys.

Findings require severity, category, confidence, evidence, and stable IDs. Evidence must refer to supplied changed lines or an exact selected context ID/range. Invalid locations are discarded. Deduplication uses normalized finding identity. Valid citation means “this supplied location was referenced,” not “the claim is proven.” The response schema supports abstention.

## Retrieval and invalidation

TypeScript/JavaScript receive explicit symbol parsing for top-level functions/classes/interfaces/types/enums/variables plus signatures, imports, paths, hashes, and line ranges. This regex/brace parser is deliberately small and does not replace a compiler AST. Other supported source extensions use honest line-window fallback chunks.

Large symbols split under an experimental token limit. Retrieval combines deterministic token overlap, symbol and import boosts; hybrid mode blends those scores with cosine similarity. Candidate count, top-k, threshold, and budgets are configurable experimental defaults. Selected IDs, scores, and reasons appear in the result.

The persistent store is a mode-0600 JSON file under `.ai-reviewer/cache`. For a single-user local CLI and a small baseline it is inspectable, dependency-free, and simpler than SQLite/native bindings or a hosted vector database. Indexes carry repository and snapshot identity. Local snapshots hash `HEAD` plus working-tree patch identities so dirty trees do not look fresh merely because `HEAD` is unchanged. Rebuilds remove deleted chunks; vectors are reused only by content hash + embedding model/version + chunker version. Retrieval rejects repository/revision mismatch.

Cross-file verification is bounded by the same top-k and prompt token limit: retrieved definitions/import neighbors can be cited as concrete evidence. No recursive agent or unbounded whole-repository prompt is used.

## Caches and retention

Review-result keys cover the exact assembled messages (therefore patch, selected context, bounded PR metadata, and instructions), model/max output configuration, prompt/schema version, and privacy-policy version. Cache hits never call the provider. Cache files and the repository index remain until explicitly removed; there is no hidden upload or automatic retention service.

Cleanup:

```powershell
Remove-Item -Recurse -LiteralPath .ai-reviewer/cache
```

Resolve and inspect that repository-local path before deletion. Removing it only discards reproducible local review/index artifacts.

## Known limitations

- Secret heuristics are intentionally bounded and can miss novel encodings or produce false positives.
- JS/TS parsing does not fully understand overloads, decorators, multiline declarations, conditional exports, or dynamic imports.
- GitHub supplies patches with API size limits; missing patches are skipped and prevent an unjustified clean claim.
- PR retrieval needs a local checkout at the exact head SHA; remote repository trees are not cloned automatically.
- Token counting is conservative estimation until provider usage arrives, not model-tokenizer exactness.
- The JSON vector store is intended for local/small-to-medium repositories, not multi-user concurrent service workloads.

# Architecture decisions

## Orchestration

The original four useful stages remain, but LangGraph was removed. The pipeline is linear, has no checkpoint/resume or conditional graph behavior, and the framework made dependency injection, fatal short-circuiting, and one retry budget harder to see. `createReviewerGraph()` remains as a compatibility facade over the explicit pipeline. This also removed the advisory-bearing LangChain/LangSmith transitive tree without a major-version migration.

Console rendering is a CLI event consumer. Domain and retrieval modules emit structured events containing run ID, stage, timing/attempt fields, revision/snapshot coverage, and usage—not raw code or prompts.

## Model boundary

`ReviewModel` and `EmbeddingAdapter` are injected interfaces. Production OpenAI adapters use structured JSON; offline tests use deterministic adapters. Trusted review rules are a system message. Metadata, code, comments, diffs, and retrieved chunks are clearly labeled untrusted user data. Prompt/schema/policy versions participate in cache keys.

Findings require severity, category, confidence, evidence, and stable IDs. The diff is parsed once into persistent old/new line mappings before segmentation. Direct evidence must cover only complete added lines actually present in that segment; line zero, omitted lines, gaps, and fragments of oversized lines are rejected. Deletions retain old-line mappings for inspection but cannot be emitted as positive-file locations: a deletion-related finding must anchor to a supplied added line or a complete retrieved context range. Invalid locations are rejected before a response can enter the cache. Deduplication uses normalized finding identity. A valid citation means “this supplied location was referenced,” not “the claim is proven.” The response schema supports abstention.

## Retrieval and invalidation

TypeScript/JavaScript are parsed with the runtime TypeScript compiler API. Top-level functions/classes/interfaces/types/enums/variables produce symbol chunks; imports, multiline declarations, strings, comments, templates, and nested syntax use AST boundaries. Source outside recognized declarations is retained in explicit file chunks. Other supported source extensions use line-window fallback chunks. Oversized physical lines become mapped `contentComplete=false` fragments rather than silently disappearing.

All chunks obey the conservative UTF-8-byte budget for ASCII and multibyte input. Retrieval generates lexical/symbol and semantic shortlists independently, merges and deduplicates their union, then ranks it. Stored/query vector counts, finite values, provider identity, and dimensions are validated; incompatible vector spaces fail explicitly. Same-file chunks remain eligible with a small boost because helpers and enclosing definitions can be relevant. Candidate count, top-k, threshold, and budgets are configurable experimental defaults. Selected IDs, scores, and reasons appear in the result.

The persistent store is a mode-0600 JSON file under `.ai-reviewer/cache`. Indexes carry repository and snapshot identity. Local snapshots hash `HEAD` plus working-tree patch identities and index the working tree. PR indexes enumerate and read the exact head Git tree, independent of the checkout’s current `HEAD` or dirty/untracked files; the trusted ignore policy remains the API-fetched base-revision policy. Rebuilds remove obsolete inputs while lexical rebuilds retain compatible vectors. Vector keys cover the exact normalized input (including path/signature/content), provider/model/version, configured/default dimension identity, chunker version, and chunk budget. Retrieval rejects repository/revision mismatch.

Cross-file verification is bounded by the same top-k and prompt token limit: retrieved definitions/import neighbors can be cited as concrete evidence. No recursive agent or unbounded whole-repository prompt is used.

## Work, request, and time budgets

`maxFiles` and `maxSegmentsPerFile` bound logical review work. `maxRequests` is a separate atomic allowance enforced immediately before every model attempt or embedding call; retries, indexing batches, and query embeddings all consume it. No new provider call starts after cancellation or exhaustion. The total abort signal covers ingestion, Git/GitHub operations, indexing, embeddings, retrieval, retry waits, and model calls. File-diff ingestion is processed in batches of eight, index reads are sequential, and model work uses the configured concurrency.

Usage keeps logical segments, model attempts, embedding calls, all actual external calls, provider-reported current-run tokens, conservative estimates, and cache hits distinct. The prompt budget includes the structured-output schema and message-envelope overhead. The fallback estimator charges one token per UTF-8 byte; it is conservative, not tokenizer-exact.

## Caches and retention

Review-result keys cover the exact assembled messages (therefore patch, selected context, bounded PR metadata, and instructions), model/max output configuration, prompt/schema version, and privacy-policy version. Cached objects are schema-validated, and findings are evidence-validated for the current segment before reuse. Provider results are written only after those checks. Cache hits never call the provider and never inflate current-run billed usage. Cache files and the repository index remain until explicitly removed; there is no hidden upload or automatic retention service.

Cleanup:

```powershell
Remove-Item -Recurse -LiteralPath .ai-reviewer/cache
```

Resolve and inspect that repository-local path before deletion. Removing it only discards reproducible local review/index artifacts.

## Known limitations

- Secret heuristics are intentionally bounded and can miss novel encodings or produce false positives.
- Compiler parsing retains all source, but symbol metadata is intentionally limited to top-level named declarations; dynamic dependency relationships are not resolved.
- GitHub supplies patches with API size limits; missing patches are skipped and prevent an unjustified clean claim.
- PR retrieval needs a local Git object database containing the head SHA; remote repository trees are not cloned or fetched automatically.
- Token counting uses a conservative byte fallback, not a model-specific tokenizer; provider usage remains authoritative when returned.
- The JSON vector store is intended for local/small-to-medium repositories, not multi-user concurrent service workloads.

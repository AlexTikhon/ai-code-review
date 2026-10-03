# Architecture decisions

## Orchestration

LangGraph was removed. The review is an explicit linear pipeline with no checkpoint/resume or conditional graph behavior, which keeps dependency injection, fatal short-circuiting, and the single request budget easy to follow. This also removed the advisory-bearing LangChain/LangSmith transitive tree without a major-version migration. No workflow framework, agent loop, or DI container is used, and the former `createReviewerGraph()` compatibility facade (and `src/graph/`) no longer exists.

```text
CLI (args, output, exit codes)
 |  requestFromCliArgs()                          src/cli/request.ts
 v
bootstrap: loadConfig + createProviders           src/cli/run-review.ts, src/cli/providers.ts
 |
 v
runReviewPipeline(args, deps)   compat wrapper    src/review/pipeline.ts
 |
 v
executeReviewPipeline(request, config, runtime)   src/review/pipeline/run-review-pipeline.ts
 |
 +--> ingest   -> Git / GitHub adapters (or an injected source)
 +--> filter   -> trusted ignore policy + privacy filter + work limits
 +--> context  -> persisted index -> prepared (runtime) index
 +--> analyze  -> ReviewModel port, EmbeddingAdapter port, review cache
 |                bounded worker pool, one FileReviewOutcome per file
 +--> finalize -> deterministic aggregation, status, summary
 |
 v
ReviewResult --> text | JSON | SARIF
```

`executeReviewPipeline` only sequences stages. Each stage is a plain function in `src/review/pipeline/` that takes explicit inputs and returns a value:

| Stage    | Modules                                                | Responsibility                                                                                                              |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ingest   | `ingest-stage.ts`                                      | Collect a `ReviewSource` from Git/GitHub. A failure is fatal and short-circuits the run.                                    |
| filter   | `filter-stage.ts`                                      | Choose the trusted ignore policy, apply privacy/ignore/type/work-limit rules, compute eligibility and truncation.           |
| context  | `context-stage.ts`                                     | Build or refresh the persisted index, then compile it once into a `PreparedRepositoryIndex`. Failure degrades to diff-only. |
| analyze  | `analyze-stage.ts`, `review-file.ts`, `concurrency.ts` | Review eligible files through the worker pool; every file returns a `FileReviewOutcome`.                                    |
| finalize | `aggregate.ts`, `finalize-stage.ts`                    | Fold outcomes in deterministic order, decide status and summary, build index-only and dry-run results.                      |

`ReviewRunRequest` (`target`, `contextMode`, `dryRun`, `indexOnly`) is the application-level command. Output format, help text, and the severity threshold are CLI concerns and never enter the core. `runReviewPipeline(args, deps)` is kept as a thin compatibility wrapper that translates `CliArgs` and delegates; it does not compose providers.

Console rendering is a CLI event consumer. Stages emit structured events (run ID, stage, filename, `durationMs`, attempt, counts, revision/snapshot, usage, cache-hit counters) for `ingest`, `filter`, `index`, `retrieve`, `analyze`, and `finalize`. Events never carry source code, diffs, prompts, PR text, or secrets, and there is no external telemetry. The `finalize` event's `durationMs` is the whole run; `data.finalizeMs` is the finalize step alone.

## Model boundary

`ReviewModel` and `EmbeddingAdapter` are the provider ports. The pipeline holds only these interfaces and never constructs a provider: `createProviders()` in `src/cli/providers.ts` is the single place that picks concrete adapters. It builds the OpenAI model only when the effective configuration authorizes external transmission, and the embedding adapter only for hybrid retrieval with separate embedding consent. A run without a model fails closed before any stage runs, except `--dry-run` and `--index`, which never need one. Production OpenAI adapters use structured JSON; offline tests and evaluation inject deterministic adapters through `ReviewRuntime`. Adding a provider means implementing a port and composing it in `providers.ts`; the pipeline does not change. Trusted review rules are a system message. Metadata, code, comments, diffs, and retrieved chunks are clearly labeled untrusted user data. Prompt/schema/policy versions participate in cache keys.

Findings require severity, category, confidence, evidence, and stable IDs. The diff is parsed once into persistent old/new line mappings before segmentation. Direct evidence must cover only complete added lines actually present in that segment; line zero, omitted lines, gaps, and fragments of oversized lines are rejected. Deletions retain old-line mappings for inspection but cannot be emitted as positive-file locations: a deletion-related finding must anchor to a supplied added line or a complete retrieved context range. Invalid locations are rejected before a response can enter the cache. Deduplication uses normalized finding identity. A valid citation means “this supplied location was referenced,” not “the claim is proven.” The response schema supports abstention.

## Retrieval and invalidation

TypeScript/JavaScript are parsed with the runtime TypeScript compiler API. Top-level functions/classes/interfaces/types/enums/variables produce symbol chunks; imports, multiline declarations, strings, comments, templates, and nested syntax use AST boundaries. Source outside recognized declarations is retained in explicit file chunks. Other supported source extensions use line-window fallback chunks. Oversized physical lines become mapped `contentComplete=false` fragments rather than silently disappearing.

All chunks obey the conservative UTF-8-byte budget for ASCII and multibyte input. Retrieval generates lexical/symbol and semantic shortlists independently, merges and deduplicates their union, then ranks it. Stored/query vector counts, finite values, provider identity, and dimensions are validated; incompatible vector spaces fail explicitly. Same-file chunks remain eligible with a small boost because helpers and enclosing definitions can be relevant. Candidate count, top-k, threshold, and budgets are configurable experimental defaults. Selected IDs, scores, and reasons appear in the result.

The persistent store is a mode-0600 JSON file under `.ai-reviewer/cache`. Indexes carry repository and snapshot identity. Local snapshots hash `HEAD` plus working-tree patch identities and index the working tree. PR indexes enumerate and read the exact head Git tree, independent of the checkout’s current `HEAD` or dirty/untracked files; the trusted ignore policy remains the API-fetched base-revision policy. Rebuilds remove obsolete inputs while lexical rebuilds retain compatible vectors. Vector keys cover the exact normalized input (including path/signature/content), provider/model/version, configured/default dimension identity, chunker version, and chunk budget. Retrieval rejects repository/revision mismatch.

Cross-file verification is bounded by the same top-k and prompt token limit: retrieved definitions/import neighbors can be cited as concrete evidence. No recursive agent or unbounded whole-repository prompt is used.

## Persisted index and prepared runtime index

The persisted `RepositoryIndex` is plain JSON (`schemaVersion` 1): repository identity, snapshot `revision`, `chunkerVersion`, `maxChunkTokens`, chunks, and a `vectors` record keyed by embedding cache key. `readIndex()` validates it with Zod (`src/retrieval/index-schema.ts`) before anything uses it: schema version, identity and revision on the index and on every chunk, chunk line ranges, vector metadata, declared dimensions equal to the value count, finite numbers, and each record key equal to its `cacheKey`.

The result is `missing`, `valid`, `corrupt` (unreadable, not JSON, or invalid) or `stale` (valid but built with a different chunker version or chunk budget). Chunks are always regenerated from source and only compatible vectors carry over, so a corrupt or stale file is rebuilt, costs at most a re-embed, and is reported as a value-free diagnostic in `context.message`. Nothing is reused from it. Writes are atomic: a unique temporary file, then rename, mode 0600, temporary removed on failure.

Retrieval runs on a `PreparedRepositoryIndex`, compiled once per run from the persisted index (`src/retrieval/prepared-index.ts`): per-chunk term sets, lower-cased symbol names, normalized import needles, per-chunk embedding input hashes, and a `Map` from input hash to stored vectors. It holds `Set`/`Map` values, is never serialized, and is shared by every review segment. This removed a per-chunk linear scan of all stored vectors (O(chunks × vectors) per segment) and the per-segment re-tokenization and re-hashing of every chunk. Ranking semantics are unchanged; `retrieveContext` still accepts a raw `RepositoryIndex` and prepares it on the fly.

## Work, request, and time budgets

`maxFiles` and `maxSegmentsPerFile` bound logical review work. `maxRequests` is a separate atomic allowance enforced immediately before every model attempt or embedding call; retries, indexing batches, and query embeddings all consume it. No new provider call starts after cancellation or exhaustion. The total abort signal covers ingestion, Git/GitHub operations, indexing, embeddings, retrieval, retry waits, and model calls. File-diff ingestion is processed in batches of eight and index reads are sequential.

`ExternalRequestBudget` is the one request boundary. Every model attempt (each retry included) and every embedding call, during indexing or for a query, calls `reserve()` synchronously immediately before the provider is invoked. A reservation either succeeds or throws when the budget is exhausted or the run is aborted. Cache hits never reserve. The budget also keeps the per-kind counts that become `usage.actualRequests` and `usage.embeddingRequests`, so those counters have one source rather than being incremented from concurrent jobs.

## Concurrency, cancellation, and aggregation

Analysis uses a small dependency-free worker pool (`runBounded` in `src/review/pipeline/concurrency.ts`). At most `config.concurrency` files are in flight, and a free worker immediately takes the next file, so one slow request no longer holds back idle workers the way fixed batches did. One file failing never cancels another. Once the total deadline aborts, no further file is started (checked synchronously at start) and in-flight requests are aborted through the shared signal. Each unstarted file is reported as failed and not attempted, with an explicit cancellation error, so an interrupted run is `partial` or `failed` and can never read as complete or clean.

Each file job returns an explicit `FileReviewOutcome` (findings, abstentions, errors, selected context, a `UsageDelta`, completed segment count, failed flag) and writes to no shared state. `aggregateOutcomes()` folds outcomes in eligible-file order regardless of completion order, then deduplicates findings and sorts them by path, first evidence line, and stable ID. Selected context stays in file, then segment, then retrieval-rank order, because rank is meaningful to consumers such as the evaluation harness. Errors and abstentions follow file order.

Usage keeps logical segments, model attempts, embedding calls, all actual external calls, provider-reported current-run tokens, conservative estimates, and cache hits distinct. The prompt budget includes the structured-output schema and message-envelope overhead. The fallback estimator charges one token per UTF-8 byte; it is conservative, not tokenizer-exact.

## Caches and retention

Review-result keys cover the exact assembled messages (therefore patch, selected context, bounded PR metadata, and instructions), model name and max output configuration, prompt/schema version, privacy-policy version, and the provider's identity: `ReviewModel.provider` plus an optional non-secret `identity` describing the API contract, such as the OpenAI endpoint origin and path. A model name alone is provider-local, so two providers that share a name never share cached answers. Identities never include API keys, URL credentials, query strings, or environment values. Cached objects are schema-validated, and findings are evidence-validated for the current segment before reuse. Provider results are written only after those checks. Cache hits never call the provider and never inflate current-run billed usage. Cache files and the repository index remain until explicitly removed; there is no hidden upload or automatic retention service.

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
- Lexical retrieval still scores every chunk for each segment. Term sets are precomputed but there is no inverted index, because zero-score chunks must stay candidates to preserve ranking behavior.
- Token usage of a model response rejected for invalid evidence is not added to `usage.inputTokens`/`outputTokens`, although the attempt itself is counted.

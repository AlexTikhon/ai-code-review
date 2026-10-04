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

```text
                 Review pipeline
                       |
         +-------------+-------------+
         |                           |
    ReviewModel                 Retrieval
     /       \                       |
    /         \                EmbeddingAdapter
OpenAI       Anthropic               |
adapter      adapter          OpenAI embeddings
```

The two provider concepts are orthogonal: any review adapter can run with or without an embedding adapter, and adding the Anthropic review adapter did not add or change an embedding adapter. `AI_REVIEW_PROVIDER` (default `openai`) is validated in `loadConfig` and acted on in exactly one place, a `switch` in `createProviders()`; no pipeline stage branches on a provider name.

`ReviewModel` and `EmbeddingAdapter` are the provider ports. The pipeline holds only these interfaces and never constructs a provider: `createProviders()` in `src/cli/providers.ts` is the single place that picks concrete adapters. It builds the OpenAI model only when the effective configuration authorizes external transmission, and the embedding adapter only for hybrid retrieval with separate embedding consent. A run without a model fails closed before any stage runs, except `--dry-run` and `--index`, which never need one. Production adapters use structured JSON, and each translates its provider's response into the one domain `ModelResult`, validated by the shared zod schema (`src/schemas/review.schema.ts`). The OpenAI adapter uses a `json_schema` response format. The Anthropic adapter uses `output_config.format` structured outputs with the same JSON Schema rewritten into Anthropic's subset (array bounds and type unions removed; the zod validator still enforces the bounds). A truncated, refused, malformed or schema-invalid answer is a typed `ReviewModelError`, never a result (see Failure semantics). Neither adapter owns prompt text: the shared prompt layer assembles one trusted system message and one untrusted user message, and an adapter only maps those onto its API. The Anthropic adapter disables the SDK's built-in retries so `executeModel` stays the only retry loop and `ExternalRequestBudget` sees every HTTP attempt. It passes the abort signal to the request and translates every SDK failure into a `ReviewModelError`; Anthropic SDK error classes are inspected only inside that adapter. Provider usage is normalized to `{inputTokens, outputTokens, actual}`: Anthropic's cached-token counts are folded into `inputTokens`, and a missing or partial usage block yields `actual: false` (zeros plus the pipeline's estimate flag), never a guessed count. offline tests and evaluation inject deterministic adapters through `ReviewRuntime`. Adding a provider means implementing a port and composing it in `providers.ts`; the pipeline does not change. Trusted review rules are a system message. Metadata, code, comments, diffs, and retrieved chunks are clearly labeled untrusted user data. Prompt/schema/policy versions participate in cache keys.

## Failure semantics

```text
SDK / HTTP failure
        |
  provider adapter            (the only code that knows SDK error classes)
        |
  ReviewModelError {kind, provider, retryable, statusCode?, retryAfterMs?, code?}
        |
  executeModel                (one retry loop; budget reserved per attempt)
        |
  SegmentFailure {status, ReviewError{code, provider, retryable}}
        |
  FileReviewOutcome -> aggregate -> ReviewResult.errors
```

`src/model/errors.ts` defines one small error class and a closed set of kinds: `authentication`, `rate_limit`, `timeout`, `network`, `provider_unavailable`, `invalid_request`, `unsupported_model`, `malformed_response`, `response_truncated`, `refused`, `aborted`, `unknown`. HTTP status mapping is shared by both adapters (401/403 authentication, 404 unsupported_model, 408 timeout, 429 rate_limit, 409 and 5xx provider_unavailable, other 4xx invalid_request). Messages are built by the adapter from a short, key-redacted excerpt of the provider's own error message; response bodies, request text and raw SDK objects are never retained. An adapter that leaks a raw error is treated as `unknown` and not retried.

**Retry.** `executeModel` consumes only normalized metadata. An attempt is retried iff the error is `retryable`, attempts remain, and neither the total deadline nor that attempt's own timeout has fired (a timed-out request may still be processed by the provider, so it is never duplicated). `retry-after` is honored up to ten seconds. Every attempt passes through the request budget first, so a retry costs a request, a cache hit and an abort before send cost none, and an unauthorized run never reaches a provider. Malformed structured output is retried within the attempt limit; truncation, refusal, authentication, invalid request and unsupported model are not. `executeModel` returns failure as data (`{ok:false, error, attempts}`) so callers learn the attempts actually made.

**Outcomes.** Each reviewed segment ends in one of: `success` (findings or a clean result, possibly an abstention); `invalid_evidence` (the model answered validly but cited evidence that was not supplied; the response is discarded, never cached or retried, and its tokens are still counted); `model_failure` (a provider failure or an unusable response: any `ReviewModelError` except `aborted`); `aborted` (deadline or caller cancellation); `internal_failure` (request budget, prompt assembly, retrieval or cache I/O). Only `success` can contribute to a reviewed file, so no failure path can read as clean. A failure also produces a `ReviewError` with a stable `code` (`MODEL_RATE_LIMIT`, `MODEL_RESPONSE_TRUNCATED`, `MODEL_MALFORMED_RESPONSE`, `MODEL_INVALID_EVIDENCE`, `REQUEST_BUDGET_EXHAUSTED`, `REVIEW_ABORTED`, `ANALYSIS_FAILED`, ...), the `provider` and `retryable`; consumers should branch on `code`, not `message`. The default `AI_REVIEW_MAX_OUTPUT_TOKENS` of 1200 is unchanged: nothing in the code shows it truncating the current schema in normal use, so a truncated answer is surfaced as `MODEL_RESPONSE_TRUNCATED` naming the setting rather than the default being guessed at.

**Prompt size.** The input-size estimate (`src/prompts/estimate.ts`) is the UTF-8 byte length of the shared system and user text plus the shared response schema and a fixed framing allowance. It never serializes any provider's request, so it is the same for every provider; real token counts come only from the provider's response.

Findings require severity, category, confidence, evidence, and stable IDs. The diff is parsed once into persistent old/new line mappings before segmentation. Direct evidence must cover only complete added lines actually present in that segment; line zero, omitted lines, gaps, and fragments of oversized lines are rejected. Deletions retain old-line mappings for inspection but cannot be emitted as positive-file locations: a deletion-related finding must anchor to a supplied added line or a complete retrieved context range. Invalid locations are rejected before a response can enter the cache. Deduplication uses normalized finding identity. A valid citation means “this supplied location was referenced,” not “the claim is proven.” The response schema supports abstention.

## Retrieval and invalidation

TypeScript/JavaScript are parsed with the runtime TypeScript compiler API. Top-level functions/classes/interfaces/types/enums/variables produce symbol chunks; imports, multiline declarations, strings, comments, templates, and nested syntax use AST boundaries. Source outside recognized declarations is retained in explicit file chunks. Other supported source extensions use line-window fallback chunks. Oversized physical lines become mapped `contentComplete=false` fragments rather than silently disappearing.

All chunks obey the conservative UTF-8-byte budget for ASCII and multibyte input. Retrieval generates lexical/symbol and semantic shortlists independently, merges and deduplicates their union, then ranks it. Stored/query vector counts, finite values, provider identity, and dimensions are validated; incompatible vector spaces fail explicitly. Same-file chunks remain eligible with a small boost because helpers and enclosing definitions can be relevant. Candidate count, top-k, threshold, and budgets are configurable experimental defaults. Selected IDs, scores, and reasons appear in the result.

The persistent store is a mode-0600 JSON file under `.ai-reviewer/cache`. Indexes carry repository and snapshot identity. Local snapshots hash `HEAD` plus working-tree patch identities and index the working tree. PR indexes enumerate and read the exact head Git tree, independent of the checkout’s current `HEAD` or dirty/untracked files; the trusted ignore policy remains the API-fetched base-revision policy. Rebuilds are incremental per file (next section), and vector keys cover the exact normalized input (including path/signature/content), provider/model/version, configured/default dimension identity, chunker version, and chunk budget. Retrieval rejects repository/revision mismatch.

Cross-file verification is bounded by the same top-k and prompt token limit: retrieved definitions/import neighbors can be cited as concrete evidence. No recursive agent or unbounded whole-repository prompt is used.

## Repository index: incremental update and prepared runtime form

```text
Persisted RepositoryIndex (plain JSON, schemaVersion 2)
   +-- files   : per-file identity (content hash, size, blob id / mtime hint, chunk ids)
   +-- chunks  : in repository order, each owned by exactly one file
   +-- vectors : keyed by embedding cache key
        |
        v   updateRepositoryIndex(previous, currentFiles, deps) -> next
   incremental reconciliation
        |      unchanged -> reuse chunks (rebound to the new revision) and vectors
        |      modified  -> re-read, re-chunk, embed only inputs without a stored vector
        |      added     -> chunk, embed
        |      deleted   -> dropped with its chunks, vectors and lexical entries
        v
   validated in memory, then written atomically
        |
        v   prepareRepositoryIndex()
PreparedRepositoryIndex (runtime only: Maps, never serialized)
   +-- chunks in deterministic order, with embedding input hashes
   +-- vectorsByInputHash        : O(1) stored-vector lookup
   +-- lexical (LexicalIndex)    : postings, symbol, path and import lookups
   +-- semantic (per embedding)  : exact-search space, packed on first hybrid query
          +-- vectors      Float64Array, row r = chunk ordinal r
          +-- norms        Float64Array, squared norms computed once
          +-- ordinals     row -> chunk (read only for the winning rows)
```

**Persisted form.** `RepositoryIndex` is plain JSON validated with Zod on load (`src/retrieval/index-schema.ts`): schema, chunker and policy versions, identity and revision on the index and on every chunk, line ranges, vector metadata, declared dimensions, finite numbers, and each vector key equal to its `cacheKey`. Every chunk must belong to exactly one `files` entry whose path matches, so a reused file can never resurrect another path’s chunks or leave ownerless ones. A file entry records its SHA-256 content hash, size, a Git blob id (revision indexes) or a working-tree mtime hint, and its chunk ids. Reuse is decided by content identity: a blob id, or a content hash after a read. A matching size and mtime only avoids that read, and only for mtimes older than a two-second window, so a file rewritten in the same timestamp tick is never trusted by timestamp. Like Git’s own index, this cannot see a same-size rewrite that also restores the old mtime; `trustFileStat: false` reads and hashes every file instead. PR indexes use blob ids from the tree listing, so unchanged files cost no `git show`.

**Load outcomes.** `readIndex()` returns `missing`, `valid`, `corrupt` (unreadable, not JSON, or any schema or consistency violation), `incompatible` (well-formed but made by another schema version, chunker version, chunk budget, privacy-policy version or repository) or `stale` (compatible but for a different revision than a caller required). Corrupt and incompatible indexes are not reused at all: they are rebuilt from source and reported as a value-free diagnostic in `context.message`. A moved revision is the normal case, not an error. The index refresh reconciles file by file and rebinds each reused chunk to the new revision, which changes only its revision and revision-derived id.

**What is reused when.**

| Change                                                              | Chunks                                            | Vectors                                              | Files read                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Nothing                                                             | all reused                                        | all reused, zero embedding requests                  | none (blob id, or size+mtime hint older than the racy window) |
| New revision, same files                                            | all reused, rebound                               | all reused                                           | none                                                          |
| One file edited                                                     | the others reused; that file re-chunked           | only inputs without a stored vector are embedded     | that file                                                     |
| File added or deleted                                               | others reused; deleted chunks and vectors dropped | new inputs embedded; orphaned vectors pruned         | the added file                                                |
| File renamed                                                        | delete plus add                                   | re-embedded: the path is part of the embedding input | the new path                                                  |
| Chunker version, chunk budget, privacy policy or repository changes | none                                              | none (their keys cover chunker and budget)           | all                                                           |
| Embedding provider, model, version or dimensions change             | all reused                                        | not reused; recomputed for the new identity          | none                                                          |

The next index is computed as a value from the previous one, validated against the same schema, and only then written with the atomic write-then-rename. Embedding failure, cancellation, request-budget exhaustion or a validation failure throws before the index is written, so the previous complete index stays intact. The paid embedding work is not lost: see the embedding checkpoint below. Only missing vectors cost requests, each batch calls `ExternalRequestBudget.reserve` first, batches run sequentially, and without embedding authorization no provider is ever called. The index stage’s event carries counters only (files total, reused, indexed, deleted and read; chunks and vectors reused and created; embedding requests), never paths, source text or vectors.

**Embedding checkpoint.** `.ai-reviewer/cache/embedding-checkpoint.json` (`src/retrieval/embedding-checkpoint.ts`) holds completed vectors of a run that did not finish. It is auxiliary: it is never a `RepositoryIndex`, retrieval never reads it, and the canonical index is still built whole, validated and replaced atomically, only after the run succeeds. Entries are the same self-describing `StoredVector` records the index uses (embedding-input hash, provider, model, version, dimensions, chunker version and chunk budget, vector), so it contains no source text and no credentials. A checkpoint vector is reused only when a chunk of the _new_ index hashes to the same input and the same cache key and embedding identity as the entry, exactly as for vectors of the previous index; a changed provider, model, version, dimension setting, chunk budget or chunk content never matches, and a renamed file is re-embedded because the path is part of the embedding input. Reused vectors make no provider call and reserve no request budget.

Lifecycle. The file is loaded only when the run is allowed to embed (dry runs and unauthorized runs neither read nor remove it). It is rewritten atomically after every eighth embedding batch, rather than after every vector, and once more when a run fails or is cancelled (provider error, malformed response, exhausted request budget, abort); a failed final index write also checkpoints every vector of the run. A checkpoint write failure is counted and reported but never fails the review, and never masks the error that ended the run. A process killed outright loses at most the batches since the last periodic write. After the canonical index is published the checkpoint is deleted, which also discards entries for chunks that no longer exist or belong to another embedding identity. A corrupt, unreadable or other-version checkpoint is ignored, reported as a value-free diagnostic and overwritten. The index stage event reports `vectorsFromCheckpoint`, `embeddingRequestsAvoided` and `checkpointSaves`; `embedding` stage events (`checkpoint_loaded`, `_hit`, `_miss`, `_saved`, `_save_failed`, `_discarded`, `_cleared`) carry counts only.

**Schema 1 indexes.** Schema 2 added `policyVersion` and the per-file table (content hash, size, blob id). A schema-1 index records neither and neither can be derived from it: the privacy policy its files were admitted under is unknown, and chunk fragments cannot reproduce a whole-file hash. Inventing them would make an old, possibly differently filtered index look validated by the current policy, so a schema-1 index is still never reused as an index. Its _vectors_, however, are self-describing, so `salvageSchemaV1Vectors` (`src/retrieval/index-legacy.ts`) feeds them into the same per-chunk reuse path as a checkpoint: the repository is re-read and re-chunked under the current policy, and a legacy vector is kept only for a current chunk with the identical input hash, cache key and embedding identity. Nothing is re-embedded that did not change; nothing from the old index's structure is trusted. Damaged vector entries are dropped individually.

**Prepared runtime form.** Retrieval runs on a `PreparedRepositoryIndex`, compiled once per run (`src/retrieval/prepared-index.ts`, `lexical-index.ts`) and shared by every review segment. The inverted `LexicalIndex` maps each term to the ordinals of the chunks containing it, plus lookups from lower-cased symbol name, file path and import needle to their chunks; ordinals ascend in repository order. The score is unchanged: overlap over query-term count, plus import, symbol and same-file boosts, capped at 1. A query now scores only chunks reached through those lists, keeps the best `candidates` by score and then repository order, and appends zero-score chunks in repository order only when positive matches do not fill the limit, which is exactly what the previous full scan’s stable sort produced. Query cost therefore follows posting-list lengths and the number of distinct import needles, not the chunk count; a term present in most chunks still touches most chunks. There is no BM25 or document-length statistic because the scorer uses none. Parity with the reference scan is tested over randomized indexes, and `retrieveContext` still accepts a raw `RepositoryIndex` and prepares it on the fly.

**Exact semantic search.** Semantic retrieval is still exact cosine similarity over every stored vector for the embedding in use; it is not approximate nearest-neighbor search, and its result is bit-identical to the scan it replaced. What changed is the work per query (`src/retrieval/semantic-index.ts`, `semanticSpaceFor` in `prepared-index.ts`):

- **Packing.** The first hybrid query packs the vectors that `findStoredVector` resolves for that embedding identity (provider, model, version, dimensions) into one row-major `Float64Array` in repository order, with each squared norm computed once. The packed space is cached on the `PreparedRepositoryIndex`, so 50 review segments build it once (`prepared.semantic.builds`). It is packed lazily, not in `prepareRepositoryIndex`, because an index can hold vectors of several embedding spaces and only the query's adapter says which one to pack; lexical-only runs never pay for it. Malformed vectors (inconsistent or zero dimensions, non-finite values) fail while packing, and a wrong-sized query fails before scoring.
- **Scoring.** The query norm is computed once per query. Each dot product accumulates in dimension order, as before; four rows are scored per pass, each with its own accumulator, so the CPU overlaps four independent additions without reordering any sum. The score is `max(0, dot / sqrt(|q|² |v|²))`, and 0 when either norm is 0.
- **Selection.** A bounded sorted buffer of `candidates` entries replaces allocating a candidate per vector and sorting them all. Rows arrive in ascending ordinal, so a row that only ties the current worst loses and equal scores keep repository order, exactly what the stable sort gave. Candidate objects and `semantic:0.xxx` reasons are created only for the winners.
- **Precision.** Float64 is kept on purpose. Float32 halves memory, but on the project's deterministic test embedder (which produces many exact ties) it changed the top-20 order for 265 of 300 queries and its membership for 52, so it is not exact.
- **Memory.** The packed space is a second copy: the loaded `RepositoryIndex` keeps its `number[][]` (the persisted JSON stays the source of truth), so a loaded index holds about `vectors × dimensions × 16` bytes of vectors: 24,576 bytes per chunk at 1,536 dimensions, about 590 MiB for 25,000 chunks. Dropping the unpacked copy would need the persisted index to stop carrying vectors in memory, which is a separate change.
- **Not done.** No ANN structure, quantization, workers or prefilter: semantic-only matches are valid results, so no safe candidate restriction exists. Embedding input hashes are still computed per chunk each run, because the persisted index does not store a chunk-to-input-hash link. Query vectors are not cached: every segment query includes its own file name and diff text, so identical queries do not occur within a run.

## Work, request, and time budgets

`maxFiles` and `maxSegmentsPerFile` bound logical review work. `maxRequests` is a separate atomic allowance enforced immediately before every model attempt or embedding call; retries, indexing batches, and query embeddings all consume it. No new provider call starts after cancellation or exhaustion. The total abort signal covers ingestion, Git/GitHub operations, indexing, embeddings, retrieval, retry waits, and model calls. File-diff ingestion is processed in batches of eight and index reads are sequential.

`ExternalRequestBudget` is the one request boundary. Every model attempt (each retry included) and every embedding call, during indexing or for a query, calls `reserve()` synchronously immediately before the provider is invoked. A reservation either succeeds or throws when the budget is exhausted or the run is aborted. Cache hits never reserve. The budget also keeps the per-kind counts that become `usage.actualRequests` and `usage.embeddingRequests`, so those counters have one source rather than being incremented from concurrent jobs.

## Concurrency, cancellation, and aggregation

Analysis uses a small dependency-free worker pool (`runBounded` in `src/review/pipeline/concurrency.ts`). At most `config.concurrency` files are in flight, and a free worker immediately takes the next file, so one slow request no longer holds back idle workers the way fixed batches did. One file failing never cancels another. Once the total deadline aborts, no further file is started (checked synchronously at start) and in-flight requests are aborted through the shared signal. Each unstarted file is reported as failed and not attempted, with an explicit cancellation error, so an interrupted run is `partial` or `failed` and can never read as complete or clean.

Each file job returns an explicit `FileReviewOutcome` (findings, abstentions, errors, selected context, a `UsageDelta`, completed segment count, failed flag) and writes to no shared state. `aggregateOutcomes()` folds outcomes in eligible-file order regardless of completion order, then deduplicates findings and sorts them by path, first evidence line, and stable ID. Selected context stays in file, then segment, then retrieval-rank order, because rank is meaningful to consumers such as the evaluation harness. Errors and abstentions follow file order.

Usage keeps logical segments, model attempts, embedding calls, all actual external calls, provider-reported current-run tokens, conservative estimates, and cache hits distinct. The prompt budget includes the structured-output schema and message-envelope overhead. The fallback estimator charges one token per UTF-8 byte; it is conservative, not tokenizer-exact.

## Caches and retention

Review-result keys cover the exact assembled messages (therefore patch, selected context, bounded PR metadata, and instructions), model name and max output configuration, prompt/schema version, privacy-policy version, and the provider's identity: `ReviewModel.provider` plus an optional non-secret `identity` describing the API contract, such as the endpoint origin and path (`openai-chat-completions/json-schema-v1@…` or `anthropic-messages/json-schema-v1@…`), so `openai:model-x` and `anthropic:model-x` never share an entry. A model name alone is provider-local, so two providers that share a name never share cached answers. Identities never include API keys, URL credentials, query strings, or environment values. Cached objects are schema-validated, and findings are evidence-validated for the current segment before reuse. Provider results are written only after those checks. Cache hits never call the provider and never inflate current-run billed usage. Cache files and the repository index remain until explicitly removed (the embedding checkpoint is the exception: it is deleted automatically once the index it fed is published); there is no hidden upload or automatic retention service.

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
- Lexical retrieval is posting-list bound: a term that occurs in most chunks (for example `return`) still touches most chunks. Semantic retrieval still compares the query vector with every stored vector, and embedding input hashes are recomputed from chunk text each run.
- The per-file containment check at scan time (one `lstat` and two `realpath` calls) runs on every run, even for unchanged files. Indexes written by schema version 1 are rebuilt from source (their vectors are salvaged, but the index itself is not migrated; see above).
- A checkpoint is replaced whole on each write, so a very large unfinished run rewrites a growing file every eight batches; and clearing it after success also drops checkpointed vectors of an embedding identity the successful run did not use.

# Pause handoff

Status: paused after local verification on 2026-11-03. This is a CLI engineering baseline; there is no web application, hosted API, database, or deployed service to keep running. The freeze revision is the commit containing this document. No push or deployment is part of this closeout.

## Reviewed baseline and closeout

The architecture review started from `41c98a1` with a clean worktree. That commit protects one model request per planned segment from optional embedding work, falls back to lexical retrieval after typed embedding failures, and reports the loss as `context.state: degraded` with a partial result. It preserves the global request cap, paid embedding checkpoints, and cancellation behavior. The existing hybrid-resilience tests passed during this review.

The closeout consists of two local commits:

1. `367b8db` fixes a reproduced source-disclosure boundary: Git interpreted `[s]ecret.ts` as a pathspec and included an excluded `secret.ts` patch in the admitted file. Local Git commands now use `--literal-pathspecs`. Six new real-Git regressions cover ignored and mandatory-sensitive siblings, exact patch statistics, diff prompts, hybrid prompts, and embedding inputs. All six failed before the fix and passed afterwards.
2. The commit containing this handoff completes the pause baseline: incomplete empty-source results retain their status; partial index-only operations exit `2` in JSON and SARIF; dry-run manifests retain their intentional exit `0`. It upgrades Zod from 3.25.76 to 4.6.7, adapts record/generic APIs, adds an LF checkout policy so Windows CRLF conversion does not fail the existing Prettier checks, and makes local/CI verification use one command including a build.

The Zod upgrade addresses [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), reported by the initial dependency audit. The [Zod migration guide](https://zod.dev/v4/changelog) explains the record and type API changes. Provider response schemas and persisted index/checkpoint formats retain their existing domain contracts; the regression suite exercises malformed inputs and legacy migrations.

## Architecture assessment

The current module boundaries are appropriate for this scope. Preserve the linear pipeline and explicit ports when resuming; a workflow framework or web/backend split would add lifecycle and operational work without a current requirement.

| Boundary                  | Current implementation and decision                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application orchestration | `src/review/pipeline/` sequences ingest, filter, context, analysis, and finalization. Plain stage outcomes and injected runtime ports keep orchestration testable without providers.                                                        |
| Source ingestion          | `src/review-sources/` separates Git subprocesses from validated, retried GitHub GETs. PR collection checks base/head/count stability and retrieves policy from the base revision. PR context reads immutable Git objects.                   |
| Privacy/admission         | Mandatory sensitive paths, rename origins, trusted ignore policy, content heuristics, and context exclusions are checked before transmission. Literal Git paths prevent an admitted filename from widening the patch selection.             |
| Request planning          | `request-plan.ts`, `patch.ts`, and shared prompt renderers fit mandatory requests before optional context. UTF-8 byte estimates trade packing efficiency for a conservative bound; they are not billing-token counts.                       |
| Provider execution        | OpenAI/Anthropic implement `ReviewModel`; embeddings have a separate port and consent. Typed failures, one retry owner per domain, and a synchronous shared request budget prevent hidden application retries and concurrent cap overruns.  |
| Retrieval                 | AST chunks for JS/TS, bounded fallback chunks for other languages, lexical postings, and exact cosine search. Lexical is a sensible default; hybrid consumes extra requests and can degrade to lexical with explicit partial status.        |
| Persistence               | User-cache namespaces outside the reviewed repository, schema validation, immutable generation files, manifest-last publication, publication locks, and vector-only checkpoints preserve complete canonical indexes and reusable paid work. |
| Findings/output           | Only supplied citable ranges survive evidence validation. Stable identities and deterministic aggregation feed text/JSON/SARIF. Valid evidence proves a location was supplied, not that the model's reasoning is correct.                   |
| Evaluation/tooling        | Offline tests and evaluation inject synthetic providers. Live evaluation is separate and explicitly opt-in. Benchmarks are local tools, not release gates or model-quality evidence.                                                        |

## Verification evidence

Environment: Windows, Node 24.11.1, npm 11.6.2, Git 2.52.0.windows.1, TypeScript 5.9.3. CI is configured for Ubuntu and Node 20; this closeout does not establish a hosted CI or Node 20 result.

Final checks executed for this freeze baseline:

| Check                   | Result                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial baseline        | Typecheck and 507/507 tests passed.                                                                                                                                     |
| Source-admission commit | Typecheck, build, 513/513 full-suite tests, and deterministic evaluation passed; 26/26 targeted source/Git checks passed.                                               |
| Freeze baseline         | Clean `npm ci`, then `npm run verify:offline`: typecheck, Prettier, build, 519/519 tests, and deterministic evaluation passed.                                          |
| Built CLI smoke         | Help `0`, invalid arguments `64`, dry-run `0`, lexical index `0`, degraded hybrid index `2`; zero provider calls. JSON/SARIF exit behavior is also tested in the suite. |
| Dependency audit        | Initial audit: one high-severity Zod advisory. After the upgrade: zero reported vulnerabilities.                                                                        |
| External providers      | No live OpenAI/Anthropic/embedding calls were made for this closeout. GitHub API behavior was tested with synthetic transports, not a real PR.                          |
| Performance             | Large retrieval/persistence benchmarks were inspected but not rerun; historical numbers in `EVALUATION.md` remain historical.                                           |

The deterministic corpus contains two tuning and six held-out cases, run in three modes. In the closeout run, held-out diff/lexical/hybrid each reported five complete, one intentionally partial, and zero failed cases. Lexical and hybrid both had retrieval Recall@3 1.0 and MRR 0.875 on four retrieval queries. This tiny mocked corpus demonstrates plumbing and expected omissions; it establishes neither real-model accuracy nor a hybrid-quality advantage.

## Reproduce and resume

```bash
git status --short
git log -2 --oneline
npm ci
npm run verify:offline
npm audit --audit-level=high
node dist/src/cli.js --help
node dist/src/cli.js --local --dry-run --context diff --format json
```

`verify:offline` runs typecheck, Prettier, build, the complete test runner, and deterministic evaluation, stopping on failure. It requires Node and Git but no credentials or external provider access. `npm ci` and `npm audit` require registry access. The tests use disposable Git repositories and OS-cache namespaces; existing test/evaluation helpers can leave synthetic fixtures in the OS temp/cache locations. Those files are not project state or required for resuming. Do not delete the entire user cache or unrelated temporary directories to clean them up.

A successful dry run is a manifest, not a completed review. Index-only exits `2` if requested hybrid indexing degraded to lexical, and exits `0` only for a complete index operation. If both `--index` and `--dry-run` are supplied, index-only remains the selected operation.

There are no project services to stop and no data migration to apply. `dist`, `.test-dist`, and dependencies are reproducible and ignored. Repository-context caches are derived, but can contain admitted source text; embedding checkpoints hold hashes/vectors and can preserve paid work. Follow the cache/privacy policy in the [README](../README.md) when handling them.

## Limits retained for a future iteration

- `classifyFile` still uses substring matching for generated diff paths: the review probe confirmed that `src/rebuild/app.ts` is classified as generated. This can exclude eligible source from the review denominator. The context-index rule already matches whole components; align diff classification with that policy and add regressions before using the tool as a required coverage gate.
- Local working-tree collection and context reads do not lock the checkout into one atomic snapshot. Run against a stable working tree; PR mode's immutable Git revision is the stronger reproducibility boundary.
- Incremental local indexing trusts size/mtime hints outside its racy window. A caller requiring content-only identity can set `trustFileStat: false` on `refreshRepositoryIndex`; the CLI does not expose that switch.
- Exact semantic search is O(chunks × dimensions); Float64 preserves ranking precision but costs eight bytes per vector component, plus metadata and simultaneous old/new stores during refresh. No vector database or ANN index is required for the current local scope.
- Privacy patterns are bounded heuristics, and prompt isolation does not guarantee model obedience. No claim of universal secret detection, sandboxing of arbitrary repositories, or production readiness is made.
- Abort handling relies on cooperative subprocess/transport/provider implementations. Injected adapters must honor the signal. The request reservation protects planned first attempts from embeddings, not every possible model retry; caches are conservatively not credited back to the embedding allowance.
- Real-provider schema acceptance, usage accounting, quality, and real-GitHub operation remain outside this local verification. No new live-model score, performance claim, or hosted CI result is implied by the freeze.

On resume, first rerun the commands above and inspect drift in dependencies and provider contracts. The first code follow-up is the bounded generated-path classifier correction described above. The next product-evidence task should be one explicitly authorized synthetic live-evaluation run for a chosen provider/model with a bounded request/cost allowance. Add a web service, storage layer, deployment, or broader feature phase only when a new requirement calls for it.

# Pause handoff

Status: paused after local verification on 2026-11-03. This is a CLI engineering baseline; there is no web application, hosted API, database, or deployed service to keep running. The freeze revision is the commit containing this document. No push or deployment is part of this closeout.

## Reviewed baseline and closeout

The latest architecture pass started from `9d43f76` with a clean worktree and rechecked the CLI/bootstrap, source adapters, privacy/filtering, request planning, provider execution, retrieval/index persistence, findings/output, and evaluation/tooling boundaries. The bounded follow-up closes the generated-path classifier issue recorded by the previous handoff; it does not add a service or change the result schema.

The closeout consists of two local commits:

1. `92ea623` aligns diff admission with the context index's exact generated/vendor path predicate. Ordinary source such as `src/rebuild/app.ts` and `src/app.snap.ts` is eligible again. Tracked vendor/minified diffs are now intentionally skipped, matching context policy, and snapshot exclusion matches the `.snap` filename suffix only. The commit adds 31 classifier regressions and five pipeline tests, including real-Git diff/lexical/hybrid runs that record provider inputs and inspect persisted context. Before the correction the focused run had 22 failures out of 38 tests; afterwards all 38 passed.
2. The commit containing this handoff records the updated policy, verification evidence, reproduced evidence limits, and resume procedure. The worktree was clean after the first commit; only README/architecture/handoff documentation belongs to this second commit.

Earlier closeout history remains relevant: `41c98a1` reserves planned model requests from optional embedding work and degrades typed embedding failures to lexical retrieval; `367b8db` makes local Git filenames literal pathspecs to prevent an admitted filename from selecting a refused sibling's patch; `9d43f76` preserves incomplete empty-source/index-only statuses, upgrades Zod, enforces LF checkouts, and shares the offline gate between local development and CI. The current full suite rechecks those contracts.

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

| Check               | Result                                                                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline recheck    | `npm run verify:offline` at `9d43f76`: typecheck, Prettier, build, 519/519 tests, and deterministic evaluation passed. Existing installed dependencies were used; this follow-up did not rerun `npm ci`.                                                                           |
| Focused regression  | 38/38 classifier/admission tests passed after 22 reproduced failures before the fix.                                                                                                                                                                                               |
| Final code baseline | `npm run verify:offline`: typecheck, Prettier, build, 555/555 tests, and deterministic evaluation passed. The documentation-only follow-up was format-checked separately.                                                                                                          |
| Built CLI smoke     | Six commands passed: help `0`, invalid arguments `64`, JSON/SARIF dry-run `0`, lexical index `0`, degraded hybrid index `2`; all reports recorded zero provider calls. Mixed lookalike/vendor fixtures reported eligible=2 and skipped=2. The smoke repository/cache were removed. |
| Dependency audit    | Current `npm audit --audit-level=high`: zero reported vulnerabilities; manifests and lockfile were unchanged.                                                                                                                                                                      |
| Evidence probes     | An injected all-abstention review returned complete/reviewed=1/exit `0`; a removed-line-only citation returned failed/`MODEL_INVALID_EVIDENCE`/exit `2`. These are retained contracts, not fixes in this slice.                                                                    |
| External providers  | No live OpenAI/Anthropic/embedding calls were made for this closeout. GitHub API behavior was tested with synthetic transports, not a real PR.                                                                                                                                     |
| Performance         | Large retrieval/persistence benchmarks were inspected but not rerun; historical numbers in `EVALUATION.md` remain historical.                                                                                                                                                      |

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

- Abstentions count as completed coverage. A run where every segment abstains can report `complete`, `reviewed > 0`, and exit `0` without an affirmative review decision. Gate consumers must inspect `abstentions`; a different product-level decision policy remains future work.
- Diff evidence accepts complete added lines only. Without supplied context evidence, a deletion-only defect cannot cite a removed line; the probe returned `MODEL_INVALID_EVIDENCE` and exit `2`. Supporting old-side ranges requires an explicit evidence/schema/prompt/output contract rather than relaxing citation validation.
- Local working-tree collection and context reads do not lock the checkout into one atomic snapshot. Run against a stable working tree; PR mode's immutable Git revision is the stronger reproducibility boundary.
- Incremental local indexing trusts size/mtime hints outside its racy window. A caller requiring content-only identity can set `trustFileStat: false` on `refreshRepositoryIndex`; the CLI does not expose that switch.
- Exact semantic search is O(chunks × dimensions); Float64 preserves ranking precision but costs eight bytes per vector component, plus metadata and simultaneous old/new stores during refresh. No vector database or ANN index is required for the current local scope.
- Privacy patterns are bounded heuristics, and prompt isolation does not guarantee model obedience. No claim of universal secret detection, sandboxing of arbitrary repositories, or production readiness is made.
- Abort handling relies on cooperative subprocess/transport/provider implementations. Injected adapters must honor the signal. The request reservation protects planned first attempts from embeddings, not every possible model retry; caches are conservatively not credited back to the embedding allowance.
- Real-provider schema acceptance, usage accounting, quality, and real-GitHub operation remain outside this local verification. No new live-model score, performance claim, or hosted CI result is implied by the freeze.

On resume, first rerun the commands above and inspect drift in dependencies and provider contracts. Before using this tool as a required review gate, define the abstention decision policy and deletion-evidence contract described above. For model-quality evidence, use one explicitly authorized synthetic live-evaluation run for a chosen provider/model with a bounded request/cost allowance. Add a web service, storage layer, deployment, or broader feature phase only when a new requirement calls for it.

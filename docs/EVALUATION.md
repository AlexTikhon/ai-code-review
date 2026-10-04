# Evaluation

## Offline suites

`npm test` is deterministic and uses no provider credentials. It covers critical audit reproductions, privacy/no-call behavior, model malformed output and evidence validation, retry/cancellation bounds, temporary Git repositories, GitHub pagination and rate-limit propagation, retrieval ranking/isolation, deletion invalidation, and vector-cache reuse.

`npm run eval` uses the labeled synthetic corpus in `eval/corpus.json`. Every case runs `runReviewPipeline` with temporary repositories and deterministic mock model/embedding providers; coverage, selected evidence, status, and usage come from the real result object. Tuning and held-out cases are separated. The corpus includes clean and buggy changes, cross-file types, semantic concepts, same-file helpers, adversarial text, and truncated multi-segment input. It compares diff-only, lexical, and hybrid modes and reports query-level Recall@3/MRR, finding precision/recall, false positives on labeled clean cases, complete-file coverage, status counts, elapsed harness time, and pipeline usage.

One local run on 2026-09-14 produced:

| Split/mode                 | Retrieval Recall@3 / MRR | Finding precision / recall | Clean FP rate | Coverage | Complete / partial / failed |
| -------------------------- | ------------------------ | -------------------------- | ------------- | -------- | --------------------------- |
| tuning diff/lexical/hybrid | n/a                      | 1.00 / 1.00                | 0.00          | 1.00     | 2 / 0 / 0                   |
| held-out diff              | 0.00 / 0.00              | 1.00 / 0.25                | 0.00          | 0.83     | 5 / 1 / 0                   |
| held-out lexical           | 1.00 / 0.875             | 1.00 / 1.00                | 0.00          | 0.83     | 5 / 1 / 0                   |
| held-out hybrid            | 1.00 / 0.875             | 1.00 / 1.00                | 0.00          | 0.83     | 5 / 1 / 0                   |

These numbers validate pipeline plumbing and demonstrate the intended context effect on a tiny corpus. Findings come from explicit deterministic rules and semantic vectors from a test-only meaning-feature embedder. They do not estimate production model quality, broad language performance, or real-world privacy. Latency is machine/run dependent and is emitted by every run rather than treated as a benchmark claim.

## Retrieval benchmarks

`npm run bench` is local, not part of CI, and asserts no timings. It prints the lexical index comparison, the semantic search comparison and the incremental-index run. The semantic section compares the pre-optimization scorer (norms recomputed per pair, a candidate per vector, full sort) against the packed exact scorer on synthetic 1,536-dimension vectors at 1,000 to 100,000 vectors and K of 3, 10, 20 and 50. Every measured query first asserts that both return identical hits. Wall-clock values are medians of five measured passes after a warm-up pass, which makes them indicative only; the structural counters (multiply-adds, norm accumulations, allocations, sort comparisons) are deterministic. It also reports one-time packing cost, packed memory against the resident unpacked copy, and the real `retrieveContext` hybrid path with the lexical-only cost subtracted. Equality with the reference is also enforced in `npm test` over seeded random cases.

## Optional live evaluation

`npm run eval:live` is the only place a real model is judged. It is opt-in, uses external provider APIs, **may incur cost**, and is never run by `npm test`, `npm run eval` or CI. It requires `AI_REVIEW_LIVE_EVAL=true`, `AI_REVIEW_ALLOW_EXTERNAL=true` and the selected provider's key, all exported in the shell (it does not read `.env`). It sends only the synthetic manifest [eval/live-cases.json](../eval/live-cases.json) (five cases, two of them clean), which is independent of `eval/corpus.json` so the deterministic eval never depends on a provider. By default it makes one request per case in `diff` mode. `AI_REVIEW_LIVE_MODES=diff,lexical,hybrid` adds retrieval modes (hybrid also needs `AI_REVIEW_ALLOW_EMBEDDINGS=true` and an OpenAI key, whichever review provider is selected), and `AI_REVIEW_LIVE_MAX_CASES` (1–8) trims the run.

```powershell
$env:AI_REVIEW_LIVE_EVAL="true"
$env:AI_REVIEW_ALLOW_EXTERNAL="true"
$env:AI_REVIEW_PROVIDER="anthropic"        # or openai
$env:ANTHROPIC_API_KEY="..."
$env:AI_REVIEW_LIVE_SAVE="true"            # optional: write eval/results/<time>-<provider>-<model>.json
npm run eval:live
```

Run it once per provider to compare them; there is no provider ranking inside the product.

**Scoring is deterministic** (`src/eval/live-score.ts`); no model judges another model. An observed finding matches an expected one when one of its evidence ranges is on the expected file and overlaps the expected line range, and its category is among the listed acceptable categories (an empty list means category is not scored). Wording is never compared. Matching is one-to-one, greedy in the pipeline's deterministic finding order. Unmatched observed findings are false positives (every finding on a clean case is one); unmatched expected findings are misses.

Reported per mode: true/false positives, false negatives, precision, recall and F1 (each `null` when undefined rather than 0), false positives on clean cases, the missed expected findings, the **invalid-evidence rate** (raw findings in responses the pipeline rejected for citing unsupplied evidence ÷ all raw findings; rejected findings are not delivered, so those cases score as misses), the **abstention rate** (answered cases where the model abstained), a per-case outcome and per-mode `outcomes` counts that keep **provider failure**, **invalid output** (unparseable structured output), **invalid evidence**, **truncation**, **abstention** and **clean success** apart (classified from the result's stable error `code`, never its message). Provider-failed and truncated cases are reported but excluded from quality metrics, since an outage or an output cap says nothing about the model's judgment; invalid-output and invalid-evidence cases deliver nothing and so count as misses, provider-reported input/output tokens (flagged if any were estimated), actual request count, and latency. Cost appears only if you supply `AI_REVIEW_LIVE_PRICE_INPUT_PER_MTOK` and `AI_REVIEW_LIVE_PRICE_OUTPUT_PER_MTOK` and all tokens were provider-reported; no prices are built in. Saved results contain IDs, metrics, categories, severities and `path:line` locations only: no prompts, source text, finding text or credentials. `eval/results/` is git-ignored and excluded from the package.

The manifest is tiny and synthetic. Its numbers are a smoke signal for a provider/model combination, not a benchmark. **No live evaluation has been run as part of this implementation** (no credentials or authorization were available), so real-provider schema acceptance, token accounting, rate-limit behavior and model quality remain unverified.

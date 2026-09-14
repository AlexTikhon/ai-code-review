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

## Optional live evaluation

Live evaluation is synthetic, capped at eight cases, and never runs in CI. It requires `AI_REVIEW_LIVE_EVAL=true`, `AI_REVIEW_ALLOW_EXTERNAL=true`, and a provider key. It runs the same pipeline in diff, lexical, and hybrid modes. Hybrid embeddings remain separately gated by `AI_REVIEW_ALLOW_EMBEDDINGS=true`; without it, the result honestly reports lexical fallback. Output includes expected labels, explicit per-label pattern matches (or `unmeasured-no-label-matcher`), actual coverage, selected evidence, status, context availability, and usage.

```powershell
$env:AI_REVIEW_LIVE_EVAL="true"
$env:AI_REVIEW_ALLOW_EXTERNAL="true"
$env:AI_REVIEW_ALLOW_EMBEDDINGS="true"
$env:AI_REVIEW_LIVE_MAX_CASES="3"
$env:OPENAI_API_KEY="..."
npm run eval:live
```

No live evaluation was run during this implementation. Provider schema compatibility, real token accounting, rate-limit behavior, embedding availability, and model quality therefore remain unverified integrations.

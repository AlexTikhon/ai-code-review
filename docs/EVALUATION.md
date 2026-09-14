# Evaluation

## Offline suites

`npm test` is deterministic and uses no provider credentials. It covers critical audit reproductions, privacy/no-call behavior, model malformed output and evidence validation, retry/cancellation bounds, temporary Git repositories, GitHub pagination and rate-limit propagation, retrieval ranking/isolation, deletion invalidation, and vector-cache reuse.

`npm run eval` uses the labeled synthetic corpus in `eval/corpus.json`. Tuning and held-out cases are separated. It compares diff-only, lexical, and hybrid modes and reports Recall@3/MRR where retrieval labels exist, finding precision/recall, false positives on labeled clean cases, coverage, elapsed harness time, and estimated tokens.

One local run on 2026-09-14 produced:

| Split/mode                 | Retrieval Recall@3 / MRR | Finding precision / recall | Clean FP rate | Coverage | Estimated tokens |
| -------------------------- | ------------------------ | -------------------------- | ------------- | -------- | ---------------- |
| tuning diff/lexical/hybrid | n/a                      | 1.00 / 1.00                | 0.00          | 1.00     | 39               |
| held-out diff              | 0.00 / 0.00              | 1.00 / 0.50                | n/a           | 0.67     | 92               |
| held-out lexical           | 1.00 / 1.00              | 1.00 / 1.00                | n/a           | 0.67     | 129              |
| held-out hybrid            | 1.00 / 1.00              | 1.00 / 1.00                | n/a           | 0.67     | 129              |

These numbers validate the harness and demonstrate the intended cross-file retrieval effect on a tiny corpus. Findings come from explicit deterministic rules and hybrid vectors from the test-only hash embedder. They do not estimate production model quality, broad language performance, or real-world privacy. Latency is machine/run dependent and is emitted by every run rather than treated as a benchmark claim.

## Optional live evaluation

Live evaluation is synthetic, capped at five cases, and never runs in CI. It requires three independent signals: `AI_REVIEW_LIVE_EVAL=true`, `AI_REVIEW_ALLOW_EXTERNAL=true`, and a provider key. The live harness uses diff-only mode so it does not embed repository content.

```powershell
$env:AI_REVIEW_LIVE_EVAL="true"
$env:AI_REVIEW_ALLOW_EXTERNAL="true"
$env:AI_REVIEW_LIVE_MAX_CASES="3"
$env:OPENAI_API_KEY="..."
npm run eval:live
```

No live evaluation was run during this implementation. Provider schema compatibility, real token accounting, rate-limit behavior, and quality therefore remain unverified integrations.

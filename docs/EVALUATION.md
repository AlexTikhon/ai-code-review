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

`npm run bench` is local, not part of CI, and asserts no timings. It prints the lexical index comparison, the semantic search comparison, a short persistence comparison and the incremental-index run. The semantic section compares the pre-optimization scorer (norms recomputed per pair, a candidate per vector, full sort) against the packed exact scorer on synthetic 1,536-dimension vectors at 1,000 to 100,000 vectors and K of 3, 10, 20 and 50. Every measured query first asserts that both return identical hits. Wall-clock values are medians of five measured passes after a warm-up pass, which makes them indicative only; the structural counters (multiply-adds, norm accumulations, allocations, sort comparisons) are deterministic. It also reports one-time packing cost, packed memory against the resident unpacked copy, and the real `retrieveContext` hybrid path with the lexical-only cost subtracted. Equality with the reference is also enforced in `npm test` over seeded random cases.

## Persistence benchmark

`npm run bench:persistence` (a short version also runs inside `npm run bench`) compares the previous layout, one JSON file with every vector as a number array, with the current manifest + metadata + binary blob layout on synthetic 1,536-dimension vectors with 9 significant digits (what an embedding API returns). Every cell is measured in its own process with a forced GC before each memory reading; times are the median of two or three runs after a discarded warm-up (a single run above 25,000 vectors). The "old" column reproduces the previous load path (read, `JSON.parse`, Zod validation, hashing, lexical build, packing with the parsed index retained); its memory matches what the real previous code measured before this change (for 5,000 vectors 225 MiB of heap including about 53 MiB of tooling baseline, here 172 MiB net). One run on a 16-core Windows machine with 16 GB, Node 24:

| Vectors | Old JSON     | New blob + metadata | Reduction |
| ------- | ------------ | ------------------- | --------- |
| 1,000   | 21 MiB       | 12 + 0.4 MiB        | 1.70×     |
| 5,000   | 103 MiB      | 59 + 2.2 MiB        | 1.70×     |
| 10,000  | 207 MiB      | 117 + 4.5 MiB       | 1.70×     |
| 17,000  | 352 MiB      | 199 + 7.7 MiB       | 1.70×     |
| 25,000  | cannot write | 293 + 11 MiB        | n/a       |
| 100,000 | cannot write | 1,172 + 46 MiB      | n/a       |

The disk saving is modest because API embeddings serialize to about 13 bytes of JSON per number against 8 bytes of binary; full-precision doubles (about 20 characters) would save more. The larger effect is a hard limit: the old format is one JSON string, and Node cannot create strings beyond about 512 MiB, so writing a 1,536-dimension index fails (`Invalid string length`) at roughly 24,000 vectors. The new layout has no such ceiling (the 100,000-vector run above is 1.2 GiB).

Ready to query (read, validate, prepare, pack; milliseconds):

| Vectors | Old   | New   | Speedup |
| ------- | ----- | ----- | ------- |
| 1,000   | 105   | 32    | 3.3×    |
| 5,000   | 413   | 120   | 3.5×    |
| 10,000  | 795   | 201   | 4.0×    |
| 17,000  | 1,288 | 343   | 3.8×    |
| 25,000  | n/a   | 482   | n/a     |
| 50,000  | n/a   | 882   | n/a     |
| 100,000 | n/a   | 1,994 | n/a     |

At 100,000 vectors the new load is about 1.7 s of reading, hashing and norms (read the blob 468 ms, SHA-256 536 ms, norms and finiteness 137 ms, metadata parse 205 ms measured separately), 216 ms to prepare and 32 ms to build the search space (which is the loaded array itself). The checksum is therefore about a quarter of the load. Norms are 7%, which is why they stay derived at load instead of being persisted.

Steady-state memory once ready, MiB above the bare process (heap holds JS objects; array buffers hold typed-array storage; RSS is what the OS reports resident and can stay high after memory is freed; peak is the OS-reported peak of the whole run, including loading):

| Vectors | Old heap | Old buffers | Old RSS | Old peak | New heap | New buffers | New RSS | New peak |
| ------- | -------- | ----------- | ------- | -------- | -------- | ----------- | ------- | -------- |
| 5,000   | 172      | 59          | 361     | 522      | 8        | 59          | 123     | 327      |
| 10,000  | 340      | 117         | 605     | 795      | 15       | 117         | 197     | 449      |
| 17,000  | 577      | 199         | 941     | 1,153    | 26       | 199         | 355     | 691      |
| 100,000 | n/a      | n/a         | n/a     | n/a      | 142      | 1,173       | 1,537   | 2,849    |

The old heap column is the unpacked `number[][]` (about 34 KiB per vector) that used to stay resident next to the packed array; the new heap is metadata and lookup tables only, and the one packed copy is what remains in buffers. Measurement limits: Node reports no true peak for its own heap, so peak is the OS working-set peak; RSS includes freed-but-retained pages; numbers are for this machine and a single synthetic one-space index.

Exact search, median milliseconds per query at K=20, is unchanged: 1,000 vectors 0.75 old / 0.63 new; 5,000 3.16 / 3.52; 10,000 6.06 / 5.94; 17,000 9.77 / 9.89; 100,000 73 (new only). Separate-process timings of this kind move by up to 25% between runs; an in-process A/B of the same data as a plain `Float64Array` and as the loaded view, interleaved, gave 5.96 and 6.32 ms/query at 10,000 vectors and 11.69 and 11.40 at 17,000, i.e. no difference attributable to the layout.

Incremental refresh of a persisted index with three edited files (load, update, publish; milliseconds): 25,000 vectors 444 / 269 / 666; 100,000 vectors 1,808 / 1,498 / 3,294, with 99,996 vectors reused as row copies, 8 embedded (the provider stub was asked for exactly those), 4 pruned, and a peak of about 3.0 GiB because the previous and the next store coexist while the next one is written. No old vector is ever parsed or converted to a JS array on this path.

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

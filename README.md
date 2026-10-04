# AI Code Reviewer

A privacy-conscious TypeScript CLI for reviewing GitHub pull-request diffs or local Git working-tree changes. It supports bounded LLM review, repository-context retrieval, JSON/SARIF output, local caching, and an offline evaluation baseline.

This is an engineering baseline, not a claim that model findings are correct or that the privacy heuristics detect every secret.

## Pipeline and modes

The source-neutral pipeline is `ingest → filter/policy → repository context → analyze → finalize`; each stage is a separate module described in [architecture decisions](docs/ARCHITECTURE.md). The repository index is updated incrementally: unchanged files reuse their chunks and embeddings, and only changed files are re-read and re-chunked. A corrupt or incompatible index cache is validated, rebuilt from source, and reported in `context.message` rather than trusted. Paid embedding work survives a failed or cancelled run in a separate checkpoint (the canonical index is still only ever replaced whole), so a retry requests just the missing vectors. `npm run bench` prints a local lexical-retrieval, exact semantic-search and incremental-index benchmark.

- Local mode collects tracked and untracked changes relative to `HEAD` or the merge-base of `--base`. Git output is NUL-delimited and external diff/textconv helpers are disabled.
- PR mode fetches immutable base/head SHAs and verifies the number of files returned against GitHub's `changed_files`. The `.ai-reviewer-ignore` policy is read from the trusted base SHA.
- `--context diff` sends only bounded diff segments.
- `--context lexical` (default) indexes the local checkout and combines keyword, symbol, and import lookup.
- `--context hybrid` adds OpenAI embeddings when separately permitted. If embeddings are not permitted it reports that semantic retrieval was unavailable and uses lexical/symbol evidence.

GitHub repository retrieval needs `--repo <checkout>` whose Git object database contains the PR head SHA. Files are read from that pinned tree, so a different `HEAD`, modified tracked files, and untracked files cannot contaminate PR context. If the object is unavailable, the result reports a diff-only fallback and cannot be `complete` for a requested context mode.

## Install and verify

Requires Node.js 20+ and Git.

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run eval
```

Help, dry-run, index construction, tests, and deterministic evaluation require no provider key and make no provider calls.

## Privacy and transmission policy

External transmission is denied by default. A model call requires both `AI_REVIEW_ALLOW_EXTERNAL=true` and `--allow-external`. Embeddings additionally require `AI_REVIEW_ALLOW_EMBEDDINGS=true`. LangSmith/LangChain tracing flags are rejected. Copy [.env.example](.env.example) for safe defaults.

Mandatory path rules block `.env` variants, private keys, common credential files, and selected credential directories before user ignore rules. A `!` rule cannot re-include them. Diffs and indexed source are also checked for a bounded set of credential patterns; matching files are blocked, while matching PR metadata is redacted. Symlinks are rejected and resolved paths must remain inside the repository. These safeguards reduce accidental disclosure but are not a general-purpose secret scanner and provide no universal guarantee.

`.ai-reviewer-ignore` uses gitignore semantics. Missing files mean no user rules; other read failures are operational errors. Local policy resolves from the Git root. PR policy comes from the immutable base revision, not the proposed PR contents. Exclusions are applied before untracked files are read.

Use a dry run before allowing transmission:

```bash
npm run build
node dist/src/cli.js --local --dry-run --format json
```

The manifest lists proposed files, omissions, destinations, and estimated requests/tokens without raw code or secrets and makes zero model/embedding calls.

## Commands

```bash
# Build
npm run build

# Offline tests and deterministic evaluation
npm test
npm run eval

# Dry-run a local review
node dist/src/cli.js --local --dry-run --format json

# Build/update a lexical repository index
node dist/src/cli.js --local --index --context lexical

# Local review (PowerShell setup shown)
$env:AI_REVIEW_ALLOW_EXTERNAL="true"
$env:OPENAI_API_KEY="..."
node dist/src/cli.js --local --context lexical --allow-external

# Local hybrid review (separate embedding consent)
$env:AI_REVIEW_ALLOW_EMBEDDINGS="true"
node dist/src/cli.js --local --context hybrid --allow-external --format sarif

# GitHub PR review; GITHUB_TOKEN is also required
node dist/src/cli.js owner repo 123 --context diff --allow-external --format json

# PR review with revision-correct local context
node dist/src/cli.js owner repo 123 --repo C:\path\to\pr-head-checkout --context lexical --allow-external
```

Use `--base main` in local mode, `--severity-threshold high|medium|low|none`, and `--format text|json|sarif`. Unknown, duplicate, missing-value, and conflicting arguments fail with exit 64.

## Results and exit codes

Statuses:

- `complete`: every eligible diff was validly reviewed without missing or truncated coverage. Intentional privacy/ignore/generated/type exclusions are outside the eligible denominator; if they are the only changes, the result explicitly makes no clean-code claim.
- `partial`: some useful review exists but eligible input was omitted, a file failed, source coverage or requested context is incomplete, or content was truncated.
- `failed`: fatal ingestion/configuration failure, or eligible input produced no completed review.

Coverage fields have documented definitions in the JSON schema/type: `discovered`, `eligible`, `attempted`, `reviewed`, `failed`, `skipped`, `omitted`, and `truncated`. `skipped` is an intentional policy exclusion; `omitted` is eligible input lost to a missing patch or work limit. A failed or wholly unreviewed eligible input is never called clean.

Exit codes are `0` for a complete result below the configured finding threshold, `1` for a complete result meeting/exceeding the threshold, `2` for failed/partial operational or incomplete review, and `64` for CLI usage errors. Dry-run/index return `0` unless their operation fails.

JSON uses schema version `1.2.0` (adds optional `code`, `provider` and `retryable` to each error). SARIF 2.1.0 includes the same status, coverage, usage, stable finding fingerprints, validated locations, and operational notifications. Machine-readable stdout contains only the report; progress/events go to stderr.

Valid insufficient-evidence responses are recorded as explicit per-segment abstentions and still count as completed review coverage; they are not findings.

## Review providers

The review model and the embedding provider are independent choices. Review can use OpenAI or Anthropic; embeddings (only needed for `--context hybrid`) are OpenAI-only today and are enabled separately. All four combinations are valid: OpenAI or Anthropic review, each with or without OpenAI embeddings.

```bash
# OpenAI review (the default; unchanged behavior)
AI_REVIEW_PROVIDER=openai
OPENAI_API_KEY=...
AI_REVIEW_MODEL=gpt-4o-mini        # optional

# Anthropic review
AI_REVIEW_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-opus-5-5    # optional; this is the default

# Optional hybrid retrieval, with either review provider
AI_REVIEW_ALLOW_EMBEDDINGS=true
OPENAI_API_KEY=...
```

`AI_REVIEW_PROVIDER` defaults to `openai`; an unknown value is a configuration error reported before any review work. `AI_REVIEW_MODEL` selects the OpenAI model and `ANTHROPIC_MODEL` the Anthropic model, so an OpenAI model name is never sent to Anthropic. The same privacy gates apply to both providers: no provider is constructed or called without `AI_REVIEW_ALLOW_EXTERNAL=true` and `--allow-external`, and a dry run needs no credentials. Retries are owned by the reviewer (the Anthropic SDK's own retries are disabled), so `AI_REVIEW_MAX_REQUESTS` counts every HTTP attempt for both providers.

Anthropic models that think before answering spend part of `AI_REVIEW_MAX_OUTPUT_TOKENS` on reasoning. If a response is cut off the file is reported with error code `MODEL_RESPONSE_TRUNCATED` (and never treated as clean); raise `AI_REVIEW_MAX_OUTPUT_TOKENS` (and `AI_REVIEW_MAX_INPUT_TOKENS`, which covers the input plus the output reservation).

## Configuration

The model remains configurable per provider (see above); the OpenAI default is `gpt-4o-mini`. Important bounds include:

```env
AI_REVIEW_MAX_INPUT_TOKENS=8000
AI_REVIEW_MAX_OUTPUT_TOKENS=1200
AI_REVIEW_MAX_PATCH_TOKENS=4000
AI_REVIEW_MAX_CONTEXT_TOKENS=1800
AI_REVIEW_MAX_SEGMENTS_PER_FILE=4
AI_REVIEW_MAX_FILES=100
AI_REVIEW_MAX_REQUESTS=200
AI_REVIEW_CONCURRENCY=2
AI_REVIEW_REQUEST_TIMEOUT_MS=60000
AI_REVIEW_TOTAL_TIMEOUT_MS=600000
AI_REVIEW_MAX_ATTEMPTS=3
AI_REVIEW_RETRIEVAL_CANDIDATES=20
AI_REVIEW_RETRIEVAL_TOP_K=5
AI_REVIEW_RELEVANCE_THRESHOLD=0.05
```

`AI_REVIEW_MAX_REQUESTS` is an actual external-call allowance shared atomically by model attempts (including retries), indexing embedding batches, and query embeddings. Logical review work, model attempts, embedding calls, current-run provider usage, estimates, and cache hits are reported separately. Cache hits do not count as current-run provider usage.

Token estimates use a conservative one-token-per-UTF-8-byte fallback; they are not tokenizer-exact. The system/user messages, structured-output schema and message-envelope overhead, bounded metadata, diff, selected context, and output reservation must fit before the provider boundary. Provider-reported token usage is recorded only for calls made in the current run.

See [architecture decisions](docs/ARCHITECTURE.md) and [evaluation details](docs/EVALUATION.md).

# AI Code Reviewer

A privacy-conscious TypeScript CLI for reviewing GitHub pull-request diffs or local Git working-tree changes. It supports bounded LLM review, repository-context retrieval, JSON/SARIF output, local caching, and an offline evaluation baseline.

This is an engineering baseline, not a claim that model findings are correct or that the privacy heuristics detect every secret.

## Pipeline and modes

The source-neutral pipeline is `ingest → filter/policy → retrieve → analyze/finalize`.

- Local mode collects tracked and untracked changes relative to `HEAD` or the merge-base of `--base`. Git output is NUL-delimited and external diff/textconv helpers are disabled.
- PR mode fetches immutable base/head SHAs and verifies the number of files returned against GitHub's `changed_files`. The `.ai-reviewer-ignore` policy is read from the trusted base SHA.
- `--context diff` sends only bounded diff segments.
- `--context lexical` (default) indexes the local checkout and combines keyword, symbol, and import lookup.
- `--context hybrid` adds OpenAI embeddings when separately permitted. If embeddings are not permitted it reports that semantic retrieval was unavailable and uses lexical/symbol evidence.

GitHub repository retrieval needs `--repo <checkout>` with `HEAD` exactly equal to the PR head SHA. Otherwise the result explicitly reports a diff-only fallback.

## Install and verify

Requires Node.js 20+ and Git.

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run eval
```

Help, dry-run, index construction, tests, and deterministic evaluation require no provider key.

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

- `complete`: every eligible scheduled diff segment was validly reviewed; no coverage truncation occurred.
- `partial`: some useful review exists but a file failed, source coverage is incomplete, content was truncated, or all discovered files were skipped.
- `failed`: fatal ingestion/configuration failure, or eligible input produced no completed review.

Coverage fields have documented definitions in the JSON schema/type: `discovered`, `eligible`, `attempted`, `reviewed`, `failed`, `skipped`, and `truncated`. A failed or wholly unreviewed input is never called clean.

Exit codes are `0` for a complete result below the configured finding threshold, `1` for a complete result meeting/exceeding the threshold, `2` for failed/partial operational or incomplete review, and `64` for CLI usage errors. Dry-run/index return `0` unless their operation fails.

JSON uses schema version `1.0.0`. SARIF 2.1.0 includes result status, coverage, usage, stable finding fingerprints, validated locations, and operational notifications. Machine-readable stdout contains only the report; progress/events go to stderr.

Valid insufficient-evidence responses are recorded as explicit per-segment abstentions and still count as completed review coverage; they are not findings.

## Configuration

The model remains configurable and defaults to `gpt-4o-mini`. Important bounds include:

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

Token estimates are conservative byte estimates; actual provider usage is recorded when supplied. The full system message, bounded metadata, diff, selected context, and output reservation must fit before the provider boundary. One retry layer handles transient failures and rate-limit backoff; authentication/configuration failures are permanent.

See [architecture decisions](docs/ARCHITECTURE.md) and [evaluation details](docs/EVALUATION.md).

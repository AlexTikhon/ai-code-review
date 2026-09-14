import { randomUUID } from "node:crypto";
import {
  readReviewCache,
  reviewCacheKey,
  writeReviewCache,
} from "../cache/review-cache.js";
import type { CliArgs } from "../cli/args.js";
import { loadConfig, type ReviewConfig } from "../config/config.js";
import { executeModel } from "../model/execution.js";
import { OpenAIReviewModel } from "../model/openai.js";
import type { ReviewModel } from "../model/types.js";
import {
  emitEvent,
  noOpEventSink,
  type EventSink,
} from "../observability/events.js";
import { assembleReviewPrompt } from "../prompts/review.js";
import {
  isMandatorySensitivePath,
  redactSensitiveText,
} from "../privacy/policy.js";
import {
  buildRepositoryIndex,
  indexPath,
  loadIndex,
} from "../retrieval/index-store.js";
import {
  OpenAIEmbeddingAdapter,
  type EmbeddingAdapter,
} from "../retrieval/embeddings.js";
import { retrieveContext } from "../retrieval/retrieve.js";
import type {
  ContextChunk,
  RepositoryIndex,
  RetrievalCandidate,
} from "../retrieval/types.js";
import { getGithubReviewSource } from "../review-sources/github/pulls.js";
import {
  getLocalDiff,
  resolveRepositoryRoot,
} from "../review-sources/local/local.js";
import { deduplicateFindings, validateFindings } from "./findings.js";
import { filterReviewFiles, ignoreFromTrustedContents } from "./filter.js";
import {
  isIgnoredPath,
  loadIgnorePolicy,
  type LoadedIgnore,
} from "./ignore.js";
import {
  POLICY_VERSION,
  PROMPT_VERSION,
  RESULT_SCHEMA_VERSION,
  type Coverage,
  type ReviewError,
  type ReviewResult,
  type ReviewSource,
  type Usage,
} from "./types.js";

export type PipelineDependencies = {
  model?: ReviewModel;
  embedding?: EmbeddingAdapter;
  events?: EventSink;
  source?: ReviewSource;
  config?: ReviewConfig;
  now?: () => number;
};
const emptyCoverage = (): Coverage => ({
  discovered: 0,
  eligible: 0,
  attempted: 0,
  reviewed: 0,
  failed: 0,
  skipped: 0,
  truncated: 0,
});
const emptyUsage = (): Usage => ({
  requests: 0,
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualRequests: 0,
  estimated: false,
  cacheHits: 0,
  latencyMs: 0,
});
function baseResult(
  runId: string,
  args: CliArgs,
  config: ReviewConfig,
  provider: string,
): ReviewResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    status: "failed",
    summary: "Review failed before any file was reviewed.",
    coverage: emptyCoverage(),
    findings: [],
    abstentions: [],
    skippedFiles: [],
    errors: [],
    usage: emptyUsage(),
    context: {
      mode: args.contextMode,
      state: args.contextMode === "diff" ? "disabled" : "unavailable",
      selected: [],
    },
    model: { provider, name: config.model, promptVersion: PROMPT_VERSION },
    policyVersion: POLICY_VERSION,
  };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sourceSummary(
  source: ReviewSource,
): Omit<ReviewSource, "files" | "trustedIgnoreContents"> {
  const { files: _files, trustedIgnoreContents: _policy, ...summary } = source;
  return {
    ...summary,
    title: redactSensitiveText(summary.title),
    description: redactSensitiveText(summary.description),
  };
}
async function ingest(
  args: CliArgs,
  policyRef: { current?: LoadedIgnore },
): Promise<ReviewSource> {
  if (args.reviewMode === "pr") {
    const source = await getGithubReviewSource(
      args.owner,
      args.repo,
      args.pullNumber,
    );
    if (args.localRepoPath)
      source.repositoryRoot = await resolveRepositoryRoot(args.localRepoPath);
    return source;
  }
  const root = await resolveRepositoryRoot(args.localRepoPath);
  const policy = await loadIgnorePolicy(root);
  policyRef.current = policy;
  return getLocalDiff(args.localBaseRef, root, {
    pathAllowed: (filename) =>
      !isMandatorySensitivePath(filename) && !isIgnoredPath(filename, policy),
  });
}
function contextUses(candidates: RetrievalCandidate[]) {
  return candidates.map(({ chunk, score, reasons }) => ({
    id: chunk.id,
    path: chunk.path,
    score,
    reasons,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }));
}

export async function runReviewPipeline(
  args: CliArgs,
  deps: PipelineDependencies = {},
): Promise<ReviewResult> {
  const runId = randomUUID();
  const events = deps.events ?? noOpEventSink;
  const started = (deps.now ?? Date.now)();
  let config: ReviewConfig;
  try {
    config = deps.config ?? loadConfig(args);
  } catch (error) {
    const fallback = {
      model: process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini",
    } as ReviewConfig;
    const result = baseResult(
      runId,
      args,
      fallback,
      deps.model?.provider ?? "openai",
    );
    result.errors.push({
      stage: "config",
      message: errorMessage(error),
      fatal: true,
    });
    result.summary = `Configuration failed: ${errorMessage(error)}`;
    return result;
  }
  const model = deps.model ?? new OpenAIReviewModel();
  const result = baseResult(runId, args, config, model.provider);
  const totalController = new AbortController();
  const timer = setTimeout(
    () => totalController.abort(),
    config.totalTimeoutMs,
  );
  timer.unref?.();
  try {
    if (
      !deps.model &&
      !config.allowExternal &&
      !args.dryRun &&
      !args.indexOnly
    ) {
      result.errors.push({
        stage: "config",
        message:
          "External model transmission is disabled. Set AI_REVIEW_ALLOW_EXTERNAL=true and pass --allow-external, or use --dry-run.",
        fatal: true,
      });
      result.summary =
        "Review failed: external transmission was not explicitly authorized.";
      return result;
    }
    const policyRef: { current?: LoadedIgnore } = {};
    emitEvent(events, runId, "ingest", "start");
    let source: ReviewSource;
    try {
      source = deps.source ?? (await ingest(args, policyRef));
    } catch (error) {
      result.errors.push({
        stage: "ingest",
        message: errorMessage(error),
        fatal: true,
      });
      result.summary = `Ingestion failed: ${errorMessage(error)}`;
      emitEvent(events, runId, "ingest", "error", {
        message: errorMessage(error),
      });
      return result;
    }
    result.source = sourceSummary(source);
    result.coverage.discovered = source.files.length;
    const policy =
      source.mode === "pr"
        ? ignoreFromTrustedContents(source.trustedIgnoreContents)
        : (policyRef.current ??
          (source.repositoryRoot
            ? await loadIgnorePolicy(source.repositoryRoot)
            : ignoreFromTrustedContents()));
    const filtered = filterReviewFiles(source, policy, config);
    result.skippedFiles = filtered.skipped;
    result.coverage.eligible = filtered.files.length;
    result.coverage.skipped = filtered.skipped.length;
    result.coverage.truncated = filtered.files.filter(
      (file) => file.truncated,
    ).length;
    if (!source.coverageComplete)
      result.errors.push({
        stage: "ingest",
        message: source.coverageError ?? "Source coverage is incomplete",
        fatal: false,
      });
    emitEvent(events, runId, "filter", "complete", {
      data: {
        discovered: result.coverage.discovered,
        eligible: result.coverage.eligible,
        skipped: result.coverage.skipped,
      },
    });

    let repositoryIndex: RepositoryIndex | undefined;
    let embedding = deps.embedding;
    if (args.contextMode !== "diff") {
      if (!source.repositoryRoot) {
        result.context = {
          mode: args.contextMode,
          state: "unavailable",
          selected: [],
          message:
            "Repository retrieval for GitHub PRs requires --repo pointing to a checkout at the PR head; using diff-only review.",
        };
      } else {
        try {
          if (source.mode === "pr") {
            const checkout = await getLocalDiff(
              undefined,
              source.repositoryRoot,
              { pathAllowed: () => false },
            );
            if (checkout.headRevision !== source.headRevision)
              throw new Error(
                `Checkout HEAD ${checkout.headRevision} does not match PR head ${source.headRevision}`,
              );
          }
          if (
            args.contextMode === "hybrid" &&
            !embedding &&
            config.allowEmbeddings
          )
            embedding = new OpenAIEmbeddingAdapter(config.embeddingModel);
          repositoryIndex = await buildRepositoryIndex({
            root: source.repositoryRoot,
            repositoryId: source.repositoryId,
            revision: source.snapshotId,
            cacheDirName: config.cacheDirName,
            maxChunkTokens: Math.min(config.maxContextTokens, 800),
            ignorePolicy: policy,
            embedding:
              args.contextMode === "hybrid" && !args.dryRun
                ? embedding
                : undefined,
            signal: totalController.signal,
          });
          result.context.state = "used";
          if (args.contextMode === "hybrid" && !embedding)
            result.context.message =
              "Semantic embeddings were not permitted; lexical/symbol retrieval was used.";
        } catch (error) {
          const message = `Repository context unavailable: ${errorMessage(error)}; using diff-only review.`;
          result.context = {
            mode: args.contextMode,
            state: "unavailable",
            selected: [],
            message,
          };
          result.errors.push({ stage: "index", message, fatal: false });
        }
      }
    }
    if (args.indexOnly) {
      result.status =
        repositoryIndex || args.contextMode === "diff" ? "complete" : "failed";
      result.summary = repositoryIndex
        ? `Indexed ${repositoryIndex.chunks.length} repository context chunks at ${indexPath(source.repositoryRoot!, config.cacheDirName)}.`
        : "No index was created.";
      return result;
    }

    const proposed = filtered.files.map((file) => ({
      filename: file.filename,
      segments: file.segments.length,
      estimatedInputTokens: file.segments.reduce(
        (sum, segment) => sum + Math.ceil(segment.text.length / 3),
        0,
      ),
    }));
    if (args.dryRun) {
      result.status = "partial";
      result.dryRun = {
        proposedFiles: proposed,
        omissions: filtered.skipped,
        destinations: [
          "local cache",
          ...(config.allowExternal
            ? [`${model.provider}:${config.model}`]
            : ["external model disabled"]),
          ...(config.allowEmbeddings
            ? [`openai:${config.embeddingModel}`]
            : []),
        ],
        estimatedRequests: proposed.reduce(
          (sum, item) => sum + item.segments,
          0,
        ),
        estimatedInputTokens: proposed.reduce(
          (sum, item) => sum + item.estimatedInputTokens,
          0,
        ),
      };
      result.summary = `Dry run: ${filtered.files.length} file(s) proposed, ${filtered.skipped.length} omitted. No model or embedding calls were made.`;
      return result;
    }
    let requestReservations = 0;
    const tasks = filtered.files.map((file) => async () => {
      result.coverage.attempted++;
      let fileFailed = false;
      let completedSegments = 0;
      for (const segment of file.segments) {
        if (++requestReservations > config.maxRequests) {
          fileFailed = true;
          result.errors.push({
            stage: "analyze",
            filename: file.filename,
            message: `Total request work limit ${config.maxRequests} exceeded`,
            fatal: false,
          });
          break;
        }
        try {
          let candidates: RetrievalCandidate[] = [];
          if (repositoryIndex && args.contextMode !== "diff")
            candidates = await retrieveContext({
              index: repositoryIndex,
              repositoryId: source.repositoryId,
              revision: source.snapshotId,
              query: `${file.filename}\n${segment.text}`,
              changedPath: file.filename,
              mode: args.contextMode,
              candidates: config.retrievalCandidates,
              topK: config.retrievalTopK,
              threshold: config.relevanceThreshold,
              embedding: args.contextMode === "hybrid" ? embedding : undefined,
              signal: totalController.signal,
            });
          const assembled = assembleReviewPrompt({
            title: source.title,
            description: source.description,
            filename: file.filename,
            fileType: file.fileType,
            segment,
            contexts: candidates.map((item) => item.chunk),
            maxInputTokens: config.maxInputTokens,
            outputReservation: config.maxOutputTokens,
            maxMetadataCharacters: config.maxMetadataCharacters,
            maxContextTokens: config.maxContextTokens,
          });
          const selectedCandidates = candidates.filter((item) =>
            assembled.context.some((chunk) => chunk.id === item.chunk.id),
          );
          result.context.selected.push(...contextUses(selectedCandidates));
          for (const candidate of selectedCandidates)
            emitEvent(events, runId, "retrieve", "context", {
              filename: file.filename,
              message: candidate.reasons.join(","),
              data: { contextId: candidate.chunk.id, score: candidate.score },
            });
          const request = {
            system: assembled.system,
            user: assembled.user,
            model: config.model,
            maxOutputTokens: config.maxOutputTokens,
          };
          const key = reviewCacheKey(request);
          const root = source.repositoryRoot;
          const cached = root
            ? await readReviewCache(root, config.cacheDirName, key)
            : undefined;
          let modelResult;
          let attempts = 0;
          result.usage.requests++;
          if (cached) {
            modelResult = cached;
            result.usage.cacheHits++;
            result.usage.inputTokens += assembled.estimatedInputTokens;
            result.usage.estimated = true;
          } else {
            const executed = await executeModel({
              model,
              request,
              runId,
              filename: file.filename,
              maxAttempts: config.maxAttempts,
              requestTimeoutMs: config.requestTimeoutMs,
              totalSignal: totalController.signal,
              events,
            });
            modelResult = executed.result;
            attempts = executed.attempts;
            if (root)
              await writeReviewCache(
                root,
                config.cacheDirName,
                key,
                modelResult,
              );
            result.usage.actualRequests += attempts;
            result.usage.inputTokens += modelResult.usage.actual
              ? modelResult.usage.inputTokens
              : assembled.estimatedInputTokens;
            result.usage.estimated =
              result.usage.estimated || !modelResult.usage.actual;
          }
          result.usage.attempts += attempts;
          result.usage.outputTokens += modelResult.usage.outputTokens;
          if (modelResult.response.abstained) {
            result.abstentions.push({
              filename: file.filename,
              segmentId: segment.id,
              reason:
                modelResult.response.abstentionReason ??
                "insufficient evidence",
            });
          }
          const validated = validateFindings(
            modelResult.response,
            file.filename,
            segment,
            assembled.context,
          );
          if (validated.length !== modelResult.response.findings.length)
            throw new Error(
              "Model returned one or more invalid evidence references",
            );
          result.findings.push(...validated);
          completedSegments++;
        } catch (error) {
          const attempts = Number(
            (error as { attempts?: number })?.attempts ?? 0,
          );
          result.usage.attempts += attempts;
          result.usage.actualRequests += attempts;
          fileFailed = true;
          result.errors.push({
            stage: "analyze",
            filename: file.filename,
            message: errorMessage(error),
            fatal: false,
          });
          break;
        }
      }
      if (fileFailed || completedSegments !== file.segments.length)
        result.coverage.failed++;
      else result.coverage.reviewed++;
    });
    for (let offset = 0; offset < tasks.length; offset += config.concurrency)
      await Promise.all(
        tasks.slice(offset, offset + config.concurrency).map((task) => task()),
      );
    result.findings = deduplicateFindings(result.findings);
    const incomplete =
      !source.coverageComplete ||
      result.coverage.failed > 0 ||
      result.coverage.truncated > 0 ||
      (result.coverage.discovered > 0 && result.coverage.reviewed === 0);
    result.status =
      result.coverage.eligible > 0 && result.coverage.reviewed === 0
        ? "failed"
        : incomplete
          ? "partial"
          : "complete";
    if (result.coverage.discovered === 0) {
      result.status = "complete";
      result.summary =
        "No changed files were discovered; no clean-code claim was made.";
    } else if (result.coverage.reviewed === 0)
      result.summary = `No files were fully reviewed (${result.coverage.skipped} skipped, ${result.coverage.failed} failed); the input is unreviewed, not clean.`;
    else
      result.summary = `${result.status === "complete" ? "Review complete" : "Review partial"}: reviewed ${result.coverage.reviewed}/${result.coverage.eligible} eligible file(s), found ${result.findings.length} validated issue(s), skipped ${result.coverage.skipped}, truncated ${result.coverage.truncated}.`;
    return result;
  } finally {
    clearTimeout(timer);
    result.usage.latencyMs = (deps.now ?? Date.now)() - started;
    emitEvent(events, runId, "finalize", "complete", {
      durationMs: result.usage.latencyMs,
      message: result.status,
      data: {
        revision: result.source?.snapshotId ?? "unavailable",
        discovered: result.coverage.discovered,
        eligible: result.coverage.eligible,
        reviewed: result.coverage.reviewed,
        failed: result.coverage.failed,
        skipped: result.coverage.skipped,
        truncated: result.coverage.truncated,
        requests: result.usage.requests,
        attempts: result.usage.attempts,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    });
  }
}

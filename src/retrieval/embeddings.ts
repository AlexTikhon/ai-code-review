import { createHash } from "node:crypto";
import {
  abortedEmbeddingError,
  dimensionMismatchError,
  embeddingHttpError,
  malformedEmbeddingError,
  missingEmbeddingKeyError,
  normalizeEmbeddingThrown,
  type EmbeddingError,
} from "./embedding-errors.js";

export interface EmbeddingAdapter {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions?: number;
  /**
   * Exactly one provider attempt: it must not retry. Retrying, backoff and
   * request accounting belong to executeEmbeddingRequest, which counts one
   * budget unit per call of this method. Failures must be thrown as
   * EmbeddingError so the executor can decide without inspecting the cause.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /**
   * Throws a non-retryable EmbeddingError when the adapter can never succeed as
   * configured (for example a missing credential). Must make no network call;
   * it runs before a request is reserved, so a misconfiguration costs nothing.
   */
  assertReady?(): void;
}

type OpenAIEmbeddingBody = { data?: unknown };

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly provider = "openai";
  readonly version = "v1";
  constructor(
    readonly model: string,
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly endpoint = "https://api.openai.com/v1/embeddings",
    /** Test seam; defaults to the global fetch at call time. */
    private readonly fetchImpl?: typeof fetch,
  ) {}
  get dimensions(): number | undefined {
    return this.model === "text-embedding-3-small"
      ? 1536
      : this.model === "text-embedding-3-large"
        ? 3072
        : this.model === "text-embedding-ada-002"
          ? 1536
          : undefined;
  }

  assertReady(): void {
    if (!this.apiKey)
      throw missingEmbeddingKeyError(this.provider, "OPENAI_API_KEY");
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.assertReady();
    // An already-cancelled call must never reach the wire.
    if (signal?.aborted) throw abortedEmbeddingError(this.provider, signal);
    try {
      return await this.send(texts, signal);
    } catch (error) {
      throw normalizeEmbeddingThrown(error, {
        provider: this.provider,
        label: "OpenAI embeddings",
        signal,
      });
    }
  }

  private async send(
    texts: string[],
    signal: AbortSignal | undefined,
  ): Promise<number[][]> {
    // The global fetch never retries, so one embed() call is one HTTP request.
    const response = await (this.fetchImpl ?? fetch)(this.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) throw await this.httpError(response);
    let payload: OpenAIEmbeddingBody | null;
    try {
      payload = (await response.json()) as OpenAIEmbeddingBody | null;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw malformedEmbeddingError(
          this.provider,
          "OpenAI embeddings returned a non-JSON body",
        );
      throw error; // a body that failed mid-read is a transport failure
    }
    const vectors = this.orderedVectors(payload?.data, texts.length);
    validateEmbeddingBatch(
      vectors,
      texts.length,
      this.dimensions,
      this.provider,
    );
    return vectors;
  }

  /** Vectors in request order, from a response whose structure is not trusted. */
  private orderedVectors(data: unknown, expected: number): number[][] {
    if (!Array.isArray(data))
      throw malformedEmbeddingError(
        this.provider,
        "OpenAI embeddings response had no data array",
      );
    if (data.length !== expected)
      throw malformedEmbeddingError(
        this.provider,
        `OpenAI embeddings response count ${data.length} does not match request count ${expected}`,
      );
    const slots = new Array<number[] | undefined>(expected).fill(undefined);
    for (const item of data as Array<{
      index?: unknown;
      embedding?: unknown;
    }>) {
      const index = item?.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= expected
      )
        throw malformedEmbeddingError(
          this.provider,
          "OpenAI embeddings response contained an invalid index",
        );
      if (slots[index] !== undefined)
        throw malformedEmbeddingError(
          this.provider,
          "OpenAI embeddings response repeated an index",
        );
      const embedding = item.embedding;
      if (
        !Array.isArray(embedding) ||
        !embedding.every((value) => typeof value === "number")
      )
        throw malformedEmbeddingError(
          this.provider,
          "OpenAI embeddings response contained a non-numeric embedding",
        );
      slots[index] = embedding as number[];
    }
    // Count and uniqueness were checked, so every slot is filled.
    return slots as number[][];
  }

  private async httpError(response: Response): Promise<EmbeddingError> {
    let code: string | undefined;
    try {
      const body = JSON.parse(await response.text()) as {
        error?: { code?: unknown; type?: unknown };
      };
      const raw = body.error?.code ?? body.error?.type;
      if (typeof raw === "string") code = raw;
    } catch {
      // A non-JSON error body is never echoed.
    }
    return embeddingHttpError({
      provider: this.provider,
      label: "OpenAI embeddings",
      status: response.status,
      code,
      headers: response.headers,
    });
  }
}
/** Deterministic local vectorizer for tests/evaluation only; it is intentionally not selected by the production CLI. */
export class DeterministicTestEmbedding implements EmbeddingAdapter {
  readonly provider = "test";
  readonly model = "hash-test";
  readonly version = "v1";
  readonly dimensions = 64;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(64).fill(0);
      for (const token of text.toLowerCase().match(/[a-z_$][\w$]*/g) ?? []) {
        const digest = createHash("sha256").update(token).digest();
        vector[digest[0]! % vector.length]! += 1;
      }
      const norm =
        Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

/**
 * Check a provider response against the request it answers; returns the
 * vector dimension. Failures are typed and permanent: a deterministic bad
 * payload would be paid for again and come back the same.
 */
export function validateEmbeddingBatch(
  vectors: number[][],
  expectedCount: number,
  expectedDimensions?: number,
  provider = "embedding",
): number {
  if (vectors.length !== expectedCount)
    throw malformedEmbeddingError(
      provider,
      `Embedding response count ${vectors.length} does not match request count ${expectedCount}`,
    );
  const dimensions = expectedDimensions ?? vectors[0]?.length ?? 0;
  if (dimensions <= 0)
    throw malformedEmbeddingError(
      provider,
      "Embedding vectors must have a positive dimension",
    );
  for (const vector of vectors) {
    if (vector.length !== dimensions)
      throw dimensionMismatchError(
        provider,
        `Embedding vector dimension mismatch; expected ${dimensions}`,
      );
    if (vector.some((value) => !Number.isFinite(value)))
      throw malformedEmbeddingError(
        provider,
        "Embedding vector contained a non-finite value",
      );
  }
  return dimensions;
}

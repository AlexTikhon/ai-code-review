import { createHash } from "node:crypto";
export interface EmbeddingAdapter {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly provider = "openai";
  readonly version = "v1";
  constructor(
    readonly model: string,
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly endpoint = "https://api.openai.com/v1/embeddings",
  ) {}
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.apiKey) throw new Error("Missing OPENAI_API_KEY for embeddings");
    const response = await fetch(this.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok)
      throw new Error(
        `OpenAI embeddings error ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}
/** Deterministic local vectorizer for tests/evaluation only; it is intentionally not selected by the production CLI. */
export class DeterministicTestEmbedding implements EmbeddingAdapter {
  readonly provider = "test";
  readonly model = "hash-test";
  readonly version = "v1";
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

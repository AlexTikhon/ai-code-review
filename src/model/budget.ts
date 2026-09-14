export type ExternalRequestKind = "model" | "embedding";

/** Synchronous reservation makes the limit atomic across concurrent promises. */
export class ExternalRequestBudget {
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly signal: AbortSignal,
    private readonly onReserve?: (kind: ExternalRequestKind) => void,
  ) {}

  reserve(kind: ExternalRequestKind): void {
    this.signal.throwIfAborted();
    if (this.used >= this.limit)
      throw new Error(
        `External request budget ${this.limit} exhausted before ${kind} call`,
      );
    this.used++;
    this.onReserve?.(kind);
  }

  get consumed(): number {
    return this.used;
  }
}

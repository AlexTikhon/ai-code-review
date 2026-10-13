export type ExternalRequestKind = "model" | "embedding";

/** The request cap was reached; no further provider call may start. */
export class RequestBudgetError extends Error {
  readonly code = "REQUEST_BUDGET_EXHAUSTED";
  constructor(
    readonly limit: number,
    readonly kind: ExternalRequestKind,
    /**
     * `total`: the global cap. `embedding_allowance`: optional embedding work
     * reached its ceiling, which keeps the rest of the cap for model review.
     */
    readonly scope: "total" | "embedding_allowance" = "total",
  ) {
    super(
      scope === "total"
        ? `External request budget ${limit} exhausted before ${kind} call`
        : `Embedding allowance ${limit} exhausted before ${kind} call; the remaining request budget is reserved for model review`,
    );
    this.name = "RequestBudgetError";
  }
}

/**
 * The single place where external provider calls are counted and capped.
 * Synchronous reservation makes the limit atomic across concurrent promises:
 * a reservation either succeeds before the call starts or throws.
 *
 * There is one cap. `capEmbeddings` does not add a second budget; it only
 * bounds how much of that one cap optional embedding work may ever use.
 */
export class ExternalRequestBudget {
  private used = 0;
  private embeddingAllowance = Number.POSITIVE_INFINITY;
  private readonly byKind: Record<ExternalRequestKind, number> = {
    model: 0,
    embedding: 0,
  };

  constructor(
    private readonly limit: number,
    private readonly signal: AbortSignal,
    private readonly onReserve?: (kind: ExternalRequestKind) => void,
  ) {}

  /**
   * Bound the embedding calls this run may start, retries included, so the
   * rest of the cap stays available to model review. It only ever lowers the
   * allowance; calls already made still count against it.
   */
  capEmbeddings(allowance: number): void {
    this.embeddingAllowance = Math.min(
      this.embeddingAllowance,
      Math.max(0, Math.floor(allowance)),
    );
  }

  reserve(kind: ExternalRequestKind): void {
    this.signal.throwIfAborted();
    if (
      kind === "embedding" &&
      this.byKind.embedding >= this.embeddingAllowance
    )
      throw new RequestBudgetError(
        this.embeddingAllowance,
        kind,
        "embedding_allowance",
      );
    if (this.used >= this.limit) throw new RequestBudgetError(this.limit, kind);
    this.used++;
    this.byKind[kind]++;
    this.onReserve?.(kind);
  }

  /** Every reserved external call, model attempts and embedding calls alike. */
  get consumed(): number {
    return this.used;
  }

  /** Calls that may still be reserved. */
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  consumedBy(kind: ExternalRequestKind): number {
    return this.byKind[kind];
  }
}

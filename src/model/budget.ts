export type ExternalRequestKind = "model" | "embedding";

/** The request cap was reached; no further provider call may start. */
export class RequestBudgetError extends Error {
  readonly code = "REQUEST_BUDGET_EXHAUSTED";
  constructor(
    readonly limit: number,
    readonly kind: ExternalRequestKind,
  ) {
    super(`External request budget ${limit} exhausted before ${kind} call`);
    this.name = "RequestBudgetError";
  }
}

/**
 * The single place where external provider calls are counted and capped.
 * Synchronous reservation makes the limit atomic across concurrent promises:
 * a reservation either succeeds before the call starts or throws.
 */
export class ExternalRequestBudget {
  private used = 0;
  private readonly byKind: Record<ExternalRequestKind, number> = {
    model: 0,
    embedding: 0,
  };

  constructor(
    private readonly limit: number,
    private readonly signal: AbortSignal,
    private readonly onReserve?: (kind: ExternalRequestKind) => void,
  ) {}

  reserve(kind: ExternalRequestKind): void {
    this.signal.throwIfAborted();
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

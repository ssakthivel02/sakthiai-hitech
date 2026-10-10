/**
 * Provider-neutral usage accounting and workspace budget enforcement for METERED providers.
 *
 * InMemoryBudgetStore here is per-process and resets on restart: a conservative per-instance ceiling only
 * (SINGLE_INSTANCE_LIMITATION when it is the configured store). For multi-instance enforcement use
 * MysqlBudgetStore (mysqlStores.ts), whose reserve is a single conditional UPDATE and therefore atomic.
 */
export type WorkspaceBudgetPolicy = {
  /** Master switch for any external provider for this workspace. */
  externalEnabled: boolean;
  /** When false, metered (pay-per-use) providers are denied for this workspace even if external is enabled. Undefined = not restricted here. */
  meteredEnabled?: boolean;
  maxRequests?: number;
  maxTokens?: number;
  /** Spend ceiling in the configured cost unit. Requires trustworthy configured rates. */
  maxCost?: number;
};

export type BudgetLimitsConfigured = (policy: WorkspaceBudgetPolicy) => boolean;
export const hasAnyBudgetLimit = (policy: WorkspaceBudgetPolicy) =>
  policy.maxRequests !== undefined || policy.maxTokens !== undefined || policy.maxCost !== undefined;

export type ReserveInput = {
  workspaceId: number;
  providerId: string;
  requestId: string;
  /** Worst-case tokens for this call, ESTIMATED (never reported as provider usage). */
  estimatedTokens: number;
  /** Worst-case cost from configured rates; undefined when no trustworthy rate exists. */
  estimatedCost?: number;
  policy: WorkspaceBudgetPolicy;
};

export type DenyReason =
  | "external_disabled"
  | "requests_exhausted"
  | "tokens_exhausted"
  | "cost_exhausted"
  | "cost_metadata_missing"
  | "no_limits_configured"
  | "store_unavailable";

export type Reservation = { id: string; workspaceId: number; providerId: string };
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: DenyReason };

export type ActualUsage = { tokens?: number; cost?: number; source: "provider_reported" | "estimated" };

export interface BudgetStore {
  reserve(input: ReserveInput): Promise<ReserveResult>;
  /** Replaces the reservation's estimate with actual usage (or keeps the estimate, flagged). */
  commit(reservation: Reservation, actual: ActualUsage): Promise<void>;
  /** Returns a reservation's holds without recording consumption (call failed before any usage). */
  release(reservation: Reservation): Promise<void>;
  usage(workspaceId: number): Promise<{ requests: number; tokens: number; cost: number; estimatedCommits: number }>;
}

type Hold = { workspaceId: number; tokens: number; cost: number; committed: boolean };

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

export class InMemoryBudgetStore implements BudgetStore {
  private readonly totals = new Map<string, { requests: number; tokens: number; cost: number; estimatedCommits: number }>();
  private readonly holds = new Map<string, Hold & { day: string }>();
  private sequence = 0;
  constructor(private readonly now: () => number = Date.now) {}

  private key(workspaceId: number, day: string) {
    return `${workspaceId}:${day}`;
  }
  private bucket(workspaceId: number, day: string) {
    const key = this.key(workspaceId, day);
    let bucket = this.totals.get(key);
    if (!bucket) {
      bucket = { requests: 0, tokens: 0, cost: 0, estimatedCommits: 0 };
      this.totals.set(key, bucket);
    }
    return bucket;
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const { policy } = input;
    if (!policy.externalEnabled) return { ok: false, reason: "external_disabled" };
    if (!hasAnyBudgetLimit(policy)) return { ok: false, reason: "no_limits_configured" };
    if (policy.maxCost !== undefined && input.estimatedCost === undefined) return { ok: false, reason: "cost_metadata_missing" };

    const day = dayKey(this.now());
    const bucket = this.bucket(input.workspaceId, day);
    if (policy.maxRequests !== undefined && bucket.requests + 1 > policy.maxRequests) return { ok: false, reason: "requests_exhausted" };
    if (policy.maxTokens !== undefined && bucket.tokens + input.estimatedTokens > policy.maxTokens) return { ok: false, reason: "tokens_exhausted" };
    if (policy.maxCost !== undefined && bucket.cost + (input.estimatedCost ?? 0) > policy.maxCost) return { ok: false, reason: "cost_exhausted" };

    bucket.requests += 1;
    bucket.tokens += input.estimatedTokens;
    bucket.cost += input.estimatedCost ?? 0;
    this.sequence += 1;
    const id = `${input.workspaceId}:${input.providerId}:${this.sequence}`;
    this.holds.set(id, { workspaceId: input.workspaceId, tokens: input.estimatedTokens, cost: input.estimatedCost ?? 0, committed: false, day });
    return { ok: true, reservation: { id, workspaceId: input.workspaceId, providerId: input.providerId } };
  }

  async commit(reservation: Reservation, actual: ActualUsage): Promise<void> {
    const hold = this.holds.get(reservation.id);
    if (!hold || hold.committed) return;
    const bucket = this.bucket(hold.workspaceId, hold.day);
    if (actual.tokens !== undefined) bucket.tokens += actual.tokens - hold.tokens;
    if (actual.cost !== undefined) bucket.cost += actual.cost - hold.cost;
    if (actual.source === "estimated") bucket.estimatedCommits += 1;
    hold.committed = true;
  }

  async release(reservation: Reservation): Promise<void> {
    const hold = this.holds.get(reservation.id);
    if (!hold || hold.committed) return;
    const bucket = this.bucket(hold.workspaceId, hold.day);
    bucket.requests -= 1;
    bucket.tokens -= hold.tokens;
    bucket.cost -= hold.cost;
    hold.committed = true;
  }

  async usage(workspaceId: number) {
    return { ...this.bucket(workspaceId, dayKey(this.now())) };
  }
}

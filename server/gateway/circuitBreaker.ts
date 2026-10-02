/**
 * Per-provider circuit breaker: CLOSED -> OPEN -> HALF_OPEN -> CLOSED.
 *
 * SINGLE_INSTANCE_LIMITATION: state lives behind BreakerStore. The default implementation is
 * in-memory, so each server instance learns about provider outages independently and state is
 * lost on restart. This is NOT distributed resilience; swap the store (e.g. a shared cache) to get that.
 * Per-provider mutual exclusion is in-process only; a shared store would also need an atomic compare-and-set.
 */
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type BreakerRecord = {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlightSince: number | null;
};

export interface BreakerStore {
  get(providerId: string): Promise<BreakerRecord | undefined>;
  set(providerId: string, record: BreakerRecord): Promise<void>;
}

export class InMemoryBreakerStore implements BreakerStore {
  private readonly records = new Map<string, BreakerRecord>();
  async get(providerId: string) {
    const record = this.records.get(providerId);
    return record ? { ...record } : undefined;
  }
  async set(providerId: string, record: BreakerRecord) {
    this.records.set(providerId, { ...record });
  }
}

export type BreakerConfig = {
  /** Consecutive provider-health failures that open the circuit. */
  failureThreshold: number;
  /** How long an OPEN circuit rejects calls before allowing one probe. */
  cooldownMs: number;
};

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = { failureThreshold: 5, cooldownMs: 30_000 };

export type Admission = { allowed: true; state: BreakerState; probe: boolean } | { allowed: false; state: BreakerState };

const fresh = (): BreakerRecord => ({ state: "CLOSED", consecutiveFailures: 0, openedAt: 0, probeInFlightSince: null });

export class CircuitBreaker {
  /** Serialises read-modify-write per provider so concurrent callers cannot both win the half-open probe. */
  private readonly locks = new Map<string, Promise<unknown>>();

  private async exclusive<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(providerId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.locks.set(providerId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(providerId) === tail) this.locks.delete(providerId);
    }
  }

  constructor(
    private readonly store: BreakerStore = new InMemoryBreakerStore(),
    private readonly config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
    private readonly now: () => number = Date.now,
  ) {
    if (!(config.failureThreshold >= 1) || !(config.cooldownMs >= 0)) throw new Error("invalid breaker configuration");
  }

  /** Decide whether a call may proceed. In HALF_OPEN exactly one probe is admitted at a time. */
  async admit(providerId: string): Promise<Admission> {
    return this.exclusive(providerId, () => this.admitUnlocked(providerId));
  }

  private async admitUnlocked(providerId: string): Promise<Admission> {
    const record = (await this.store.get(providerId)) ?? fresh();
    const now = this.now();

    if (record.state === "CLOSED") return { allowed: true, state: "CLOSED", probe: false };

    if (record.state === "OPEN") {
      if (now - record.openedAt < this.config.cooldownMs) return { allowed: false, state: "OPEN" };
      await this.store.set(providerId, { ...record, state: "HALF_OPEN", probeInFlightSince: now });
      return { allowed: true, state: "HALF_OPEN", probe: true };
    }

    // HALF_OPEN: one probe at a time; a probe that never reported back expires after one cooldown.
    const stuck = record.probeInFlightSince !== null && now - record.probeInFlightSince >= Math.max(this.config.cooldownMs, 1);
    if (record.probeInFlightSince === null || stuck) {
      await this.store.set(providerId, { ...record, probeInFlightSince: now });
      return { allowed: true, state: "HALF_OPEN", probe: true };
    }
    return { allowed: false, state: "HALF_OPEN" };
  }

  async recordSuccess(providerId: string): Promise<void> {
    await this.exclusive(providerId, () => this.store.set(providerId, fresh()));
  }

  /** A provider-health failure (timeout, network, 429, 5xx, malformed). */
  async recordFailure(providerId: string): Promise<void> {
    await this.exclusive(providerId, () => this.recordFailureUnlocked(providerId));
  }

  private async recordFailureUnlocked(providerId: string): Promise<void> {
    const record = (await this.store.get(providerId)) ?? fresh();
    const now = this.now();
    if (record.state === "HALF_OPEN") {
      await this.store.set(providerId, { state: "OPEN", consecutiveFailures: record.consecutiveFailures + 1, openedAt: now, probeInFlightSince: null });
      return;
    }
    const failures = record.consecutiveFailures + 1;
    if (failures >= this.config.failureThreshold) {
      await this.store.set(providerId, { state: "OPEN", consecutiveFailures: failures, openedAt: now, probeInFlightSince: null });
    } else {
      await this.store.set(providerId, { ...record, consecutiveFailures: failures });
    }
  }

  /**
   * A result that says nothing about provider health (auth/config/caller errors). It must neither
   * open nor close the circuit; it only releases a held half-open probe slot.
   */
  async recordNeutral(providerId: string): Promise<void> {
    await this.exclusive(providerId, () => this.recordNeutralUnlocked(providerId));
  }

  private async recordNeutralUnlocked(providerId: string): Promise<void> {
    const record = await this.store.get(providerId);
    if (record && record.state === "HALF_OPEN" && record.probeInFlightSince !== null) {
      await this.store.set(providerId, { ...record, probeInFlightSince: null });
    }
  }

  async state(providerId: string): Promise<BreakerState> {
    const record = await this.store.get(providerId);
    if (!record) return "CLOSED";
    if (record.state === "OPEN" && this.now() - record.openedAt >= this.config.cooldownMs) return "OPEN";
    return record.state;
  }
}

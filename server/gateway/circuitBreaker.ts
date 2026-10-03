/**
 * Per-provider circuit breaker: CLOSED -> OPEN -> HALF_OPEN -> CLOSED.
 *
 * State lives behind BreakerStore. The default InMemoryBreakerStore is per-process (each instance learns
 * about outages independently and loses state on restart: SINGLE_INSTANCE_LIMITATION when it is used).
 * A store that implements compareAndSet (see mysqlStores.ts) makes every transition atomic across
 * instances: the breaker re-reads and retries on conflict, so exactly one instance wins a HALF_OPEN probe.
 * The in-process per-provider mutex only reduces contention; correctness comes from compareAndSet.
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
  /**
   * Optional atomic transition. Writes `next` only if the stored record still equals `expected`
   * (`undefined` = no record). Returns false on conflict. Required for multi-instance correctness.
   */
  compareAndSet?(providerId: string, expected: BreakerRecord | undefined, next: BreakerRecord): Promise<boolean>;
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

const MAX_CAS_ATTEMPTS = 16;
type Decision<T> = { next: BreakerRecord | null; result: T };

export class CircuitBreaker {
  /** Serialises read-modify-write per provider inside this process (contention reduction only). */
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

  /** Read -> decide -> atomic write, retried on cross-instance conflict. */
  private transition<T>(providerId: string, decide: (record: BreakerRecord | undefined, now: number) => Decision<T>): Promise<T> {
    return this.exclusive(providerId, async () => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const stored = await this.store.get(providerId);
        const decision = decide(stored, this.now());
        if (decision.next === null) return decision.result;
        if (!this.store.compareAndSet) {
          await this.store.set(providerId, decision.next);
          return decision.result;
        }
        if (await this.store.compareAndSet(providerId, stored, decision.next)) return decision.result;
      }
      throw new Error("circuit breaker state contention");
    });
  }

  constructor(
    private readonly store: BreakerStore = new InMemoryBreakerStore(),
    private readonly config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
    private readonly now: () => number = Date.now,
  ) {
    if (!(config.failureThreshold >= 1) || !(config.cooldownMs >= 0)) throw new Error("invalid breaker configuration");
  }

  /**
   * Decide whether a call may proceed. In HALF_OPEN exactly one probe is admitted at a time.
   * If the state store itself fails (outage, corrupt row, contention) the default is FAIL CLOSED;
   * pass failOpen for providers with no cost/security impact (self-hosted) so their availability
   * does not depend on the shared store.
   */
  async admit(providerId: string, options: { failOpen?: boolean } = {}): Promise<Admission> {
    try {
      return await this.transition<Admission>(providerId, (stored, now) => this.admitDecision(stored ?? fresh(), now));
    } catch {
      return options.failOpen ? { allowed: true, state: "CLOSED", probe: false } : { allowed: false, state: "OPEN" };
    }
  }

  private admitDecision(record: BreakerRecord, now: number): Decision<Admission> {
    if (record.state === "CLOSED") return { next: null, result: { allowed: true, state: "CLOSED", probe: false } };

    if (record.state === "OPEN") {
      if (now - record.openedAt < this.config.cooldownMs) return { next: null, result: { allowed: false, state: "OPEN" } };
      return { next: { ...record, state: "HALF_OPEN", probeInFlightSince: now }, result: { allowed: true, state: "HALF_OPEN", probe: true } };
    }

    // HALF_OPEN: one probe at a time; a probe that never reported back expires after one cooldown.
    const stuck = record.probeInFlightSince !== null && now - record.probeInFlightSince >= Math.max(this.config.cooldownMs, 1);
    if (record.probeInFlightSince === null || stuck) {
      return { next: { ...record, probeInFlightSince: now }, result: { allowed: true, state: "HALF_OPEN", probe: true } };
    }
    return { next: null, result: { allowed: false, state: "HALF_OPEN" } };
  }

  async recordSuccess(providerId: string): Promise<void> {
    await this.exclusive(providerId, () => this.store.set(providerId, fresh())).catch(() => undefined);
  }

  /** A provider-health failure (timeout, network, 429, 5xx, malformed). */
  async recordFailure(providerId: string): Promise<void> {
    await this.transition<void>(providerId, (stored, now) => {
      const record = stored ?? fresh();
      if (record.state === "HALF_OPEN") {
        return { next: { state: "OPEN", consecutiveFailures: record.consecutiveFailures + 1, openedAt: now, probeInFlightSince: null }, result: undefined };
      }
      const failures = record.consecutiveFailures + 1;
      if (failures >= this.config.failureThreshold) {
        return { next: { state: "OPEN", consecutiveFailures: failures, openedAt: now, probeInFlightSince: null }, result: undefined };
      }
      return { next: { ...record, consecutiveFailures: failures }, result: undefined };
    }).catch(() => undefined);
  }

  /**
   * A result that says nothing about provider health (auth/config/caller errors). It must neither
   * open nor close the circuit; it only releases a held half-open probe slot.
   */
  async recordNeutral(providerId: string): Promise<void> {
    await this.transition<void>(providerId, stored => {
      if (stored && stored.state === "HALF_OPEN" && stored.probeInFlightSince !== null) {
        return { next: { ...stored, probeInFlightSince: null }, result: undefined };
      }
      return { next: null, result: undefined };
    }).catch(() => undefined);
  }

  async state(providerId: string): Promise<BreakerState> {
    try {
      const record = await this.store.get(providerId);
      return record ? record.state : "CLOSED";
    } catch {
      return "OPEN"; // unreadable state is reported conservatively
    }
  }
}

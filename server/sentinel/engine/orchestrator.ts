import type { AsyncPolicy, CaseDoc, Decision } from "./types";
import { Broker } from "./broker";
import type { ToolTransport } from "./transport";
import type { VerifyOptions } from "./verifier";
import { Investigation } from "./investigation";
import type { Action, CancelToken, RunResult } from "./investigation";
import type { Checkpoint } from "./checkpoint";

export type { CancelToken, RunResult } from "./investigation";
type ToolAction = Extract<Action, { kind: "TOOL" }>;

export interface AsyncRunOptions {
  policy: AsyncPolicy; transport: ToolTransport; taxonomy: Record<string, string>;
  verify?: VerifyOptions; cancel?: CancelToken; signal?: AbortSignal;
  /** wall-clock limit for one policy decision (a model call). Exceeding it is a contained POLICY_ERROR. */ policyTimeoutMs?: number;
  /** wall-clock limit for one tool attempt; exceeding it counts as a timed-out attempt and is retried within the broker's bounds */ toolAttemptTimeoutMs?: number;
  /** how often a polled CancelToken is observed while a policy or tool call is awaited (ms) */ cancelPollMs?: number;
  onStep?: (step: number, broker: Broker) => void;
  onCheckpoint?: (cp: Checkpoint) => void | Promise<void>;
  resumeFrom?: Checkpoint;
  /** see InvMeta.strictLedger */ strictLedger?: boolean;
}

class Interrupted extends Error { readonly kind: "ABORT" | "TIMEOUT"; constructor(kind: "ABORT" | "TIMEOUT") { super(kind); this.kind = kind; } }

/** Await `p`, but give up on abort or timeout. The abandoned promise is detached so a late rejection cannot surface. */
function guarded<T>(p: T | Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const end = (fn: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => end(() => reject(new Interrupted("ABORT")));
    if (signal.aborted) return reject(new Interrupted("ABORT"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => end(() => reject(new Interrupted("TIMEOUT"))), timeoutMs);
    Promise.resolve(p).then((v) => end(() => resolve(v)), (e) => end(() => reject(e)));
  });
}

/**
 * Asynchronous driver for the same Investigation state machine. Policy decisions and tool calls may take real time; both are
 * cancellable (AbortSignal and/or polled CancelToken) and bounded (policyTimeoutMs, toolAttemptTimeoutMs). Checkpoints are emitted before
 * each tool call and after each tool result so a crash can be resumed with resumeFrom.
 */
export async function investigateAsync(c: CaseDoc, o: AsyncRunOptions): Promise<RunResult> {
  const token: CancelToken = o.cancel ?? { cancelled: false };
  const ac = new AbortController();
  const onExternal = () => { token.cancelled = true; ac.abort(); };
  if (o.signal) { if (o.signal.aborted) onExternal(); else o.signal.addEventListener("abort", onExternal, { once: true }); }
  const poll = setInterval(() => { if (token.cancelled) ac.abort(); }, Math.max(1, o.cancelPollMs ?? 10));
  try {
    const broker = new Broker(c, o.transport);
    const meta = { policy_id: o.policy.id, policy_kind: o.policy.kind, taxonomy: o.taxonomy, ...(o.verify ? { verify: o.verify } : {}), cancel: token, ...(o.policy.note ? { note: o.policy.note } : {}), ...(o.strictLedger ? { strictLedger: true } : {}) };
    let inv: Investigation;
    if (o.resumeFrom) inv = Investigation.resume(c, broker, o.resumeFrom, meta);
    else { inv = new Investigation(c, broker, meta); inv.start(); await o.onCheckpoint?.(inv.snapshot()); }
    if (inv.phase === "AWAIT_TOOL") inv.cancelBeforeCall();
    for (;;) {
      const a = inv.nextAction();
      if (a.kind === "DONE") break;
      let tool: ToolAction | null = a.kind === "TOOL" ? a : null;
      if (a.kind === "DECIDE") {
        let d: Decision;
        try { d = await guarded(o.policy.next(a.view, ac.signal), ac.signal, o.policyTimeoutMs); }
        catch (e) {
          if (e instanceof Interrupted && e.kind === "ABORT") inv.cancelInFlight("policy");
          else inv.policyFailure(e instanceof Interrupted ? "POLICY_TIMEOUT" : String((e as Error)?.message ?? e));
          break;
        }
        const b = inv.applyDecision(d);
        if (b.kind === "DONE") break;
        tool = b as ToolAction;
        await o.onCheckpoint?.(inv.snapshot());
      }
      let res;
      try { res = await broker.callAsync(tool!.request, { signal: ac.signal, ...(o.toolAttemptTimeoutMs ? { attemptTimeoutMs: o.toolAttemptTimeoutMs } : {}) }); }
      catch (e) { if (e instanceof Error && e.name === "CallAborted") { inv.cancelInFlight("tool"); break; } throw e; }
      inv.recordTool(res);
      o.onStep?.(tool!.step, broker);
      await o.onCheckpoint?.(inv.snapshot());
    }
    const result = inv.finish();
    return result;
  } finally {
    clearInterval(poll);
    o.signal?.removeEventListener("abort", onExternal);
  }
}

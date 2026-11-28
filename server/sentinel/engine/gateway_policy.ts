import type { AsyncPolicy, Decision, PolicyView } from "./types";
import type { ModelTransport } from "./model_transport";
import { ContractError, buildPrompt, parseDecision, stripReasoning } from "./llm_contract";
import { hashOf, sha256 } from "./canon";
import { falseActionClaimLocations } from "./verifier";
import type { ModelMeta } from "./types";

export interface GatewayOptions {
  /** hard cap on model calls for one investigation (including format retries) */ maxModelCalls?: number;
  /** extra attempts allowed when a reply fails the output contract (the validator's reason is fed back) */ formatRetries?: number;
  /** replies longer than this are rejected before parsing */ maxResponseChars?: number;
  /** a prompt larger than this is never sent: the decision fails closed (PROMPT_TOO_LARGE) instead of silently truncating evidence or running up cost */ maxPromptChars?: number;
}

/**
 * Model-backed policy: prompt from llm_contract.buildPrompt -> ModelTransport -> llm_contract.parseDecision.
 * It is UNTRUSTED like any policy: everything it returns still passes the broker, the verifier, the ledger audit and the trace.
 * One instance serves ONE investigation (it counts that investigation's model calls).
 */
export class GatewayPolicy implements AsyncPolicy {
  readonly id: string; readonly kind = "llm" as const; readonly note: string;
  modelCalls = 0; tokensIn = 0; tokensOut = 0;
  private readonly t: ModelTransport; private readonly o: Required<GatewayOptions>;
  constructor(transport: ModelTransport, opts: GatewayOptions = {}) {
    this.t = transport; this.id = `gateway:${transport.id}`;
    this.o = { maxModelCalls: opts.maxModelCalls ?? 40, formatRetries: opts.formatRetries ?? 1, maxResponseChars: opts.maxResponseChars ?? 20_000, maxPromptChars: opts.maxPromptChars ?? 200_000 };
    this.note = transport.kind === "mock" ? "LLM-contract policy over a MOCK transport: replies are scripted by the caller; this is NOT model reasoning." : `LLM policy via ${transport.kind} transport ${transport.id}`;
  }

  async next(view: PolicyView, signal?: AbortSignal): Promise<Decision> {
    const base = buildPrompt(view);
    if (base.system.length + base.user.length > this.o.maxPromptChars) throw new Error("PROMPT_TOO_LARGE");
    let user = base.user, lastReason = "", finalOnly = false;
    const rejections: NonNullable<ModelMeta["contract_rejections"]> = [];
    for (let attempt = 0; attempt <= this.o.formatRetries; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error("MODEL_CALL_ABORTED");
      // Retry feedback also consumes prompt space. Reject before reserving another model call.
      if (base.system.length + user.length > this.o.maxPromptChars) throw new Error("PROMPT_TOO_LARGE");
      if (this.modelCalls >= this.o.maxModelCalls) throw new Error("MODEL_CALL_BUDGET_EXHAUSTED");
      this.modelCalls++;
      const res = await this.t.complete({ system: base.system, user, attempt, ...(signal ? { signal } : {}) });
      this.tokensIn += res.tokens_in ?? 0; this.tokensOut += res.tokens_out ?? 0;
      // A transport may ignore cancellation and return late. Account for the spent call, but never continue it.
      if (signal?.aborted) throw signal.reason ?? new Error("MODEL_CALL_ABORTED");
      try {
        if (typeof res.text !== "string") throw new ContractError("reply is not text");
        if (res.text.length > this.o.maxResponseChars) throw new ContractError("reply too long");
        const d = parseDecision(res.text, view);
        if (finalOnly && d.type !== "FINAL") throw new ContractError("FINAL required after action claim rejection");
        if (d.type === "FINAL" && falseActionClaimLocations(d.final).length) {
          finalOnly = true;
          throw new ContractError("FINAL action claim: report observed states and proposals only");
        }
        if (d.type === "CALL") {
          // Match the broker's exact cache identity, including absent vs explicit empty args.
          // Denials are not cached; completed errors/timeouts/no-data results are.
          const key = hashOf({ t: d.request.tool, g: d.request.target, a: d.request.args ?? null });
          if (view.history.some((h) => h.status !== "DENIED" && hashOf({ t: h.request.tool, g: h.request.target, a: h.request.args ?? null }) === key)) {
            throw new ContractError("request already cached: choose a different authorized read or FINAL");
          }
        }
        return { ...d, model_meta: { reasoning_chars: stripReasoning(res.text).reasoning_chars, prompt_sha256: sha256(base.system + "\n" + user), response_sha256: sha256(res.text), attempt, model_calls: this.modelCalls, ...(rejections.length ? { contract_rejections: rejections.slice() } : {}), ...(res.tokens_in !== undefined ? { tokens_in: res.tokens_in } : {}), ...(res.tokens_out !== undefined ? { tokens_out: res.tokens_out } : {}), transport: this.t.kind, ...(res.provenance ? { provenance: res.provenance } : {}) } };
      } catch (e) {
        if (!(e instanceof ContractError)) throw e;
        lastReason = e.message.replace(/[^\w :.\-]/g, "?").slice(0, 80);       // reason text is ours, never the model's reply
        if (typeof res.text === "string") rejections.push({ attempt, reason: lastReason, prompt_sha256: sha256(base.system + "\n" + user), response_sha256: sha256(res.text) });
        user = base.user + `\n\nYour previous reply was rejected by the decision validator (${lastReason}). Reply with exactly one valid JSON object and nothing else.`;
      }
    }
    throw new ContractError(`model reply rejected after ${this.o.formatRetries + 1} attempt(s): ${lastReason}`);
  }
}

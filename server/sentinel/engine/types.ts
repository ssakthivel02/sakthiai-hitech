export const READ_TOOLS = ["metrics.query", "logs.search", "deploys.list", "config.get", "health.check", "runbook.lookup", "tickets.search"] as const;
export const WRITE_TOOLS = ["service.restart", "config.set", "deploy.rollback", "vm.reboot", "iam.revoke", "firewall.update", "db.failover"] as const;

export interface Limits { max_tool_calls: number; max_steps: number; max_retries_per_call: number; max_virtual_ms: number }
export interface CaseDoc {
  case_id: string; tenant: string; objective: string;
  alert: { title: string; severity: string; service: string; fired_at: string; description: string };
  operator_notes: string[]; inventory: { services: string[]; hosts: string[] };
  allowed_tools: string[]; limits: Limits;
}
export interface WorldRecord { ts: string; level: string; text: string }
export interface WorldObs { obs_id: string; tool: string; target: string; tenant: string; source_system: string; records: WorldRecord[]; fault?: string }
export interface World { case_id: string; tenant: string; observations: WorldObs[] }

export interface ToolRequest { tool: string; target: string; args?: Record<string, unknown> }
export interface EvRecord { rid: string; obs_id: string; ts: string; level: string; text: string; quarantined: boolean }
export type CallStatus = "OK" | "NO_DATA" | "TIMEOUT" | "ERROR" | "DENIED";
export interface ToolResult {
  seq: number; request: ToolRequest; status: CallStatus; deny_reason?: string; error?: string;
  source_system?: string; records: EvRecord[];
  quarantined: Array<{ rid: string; pattern: string; original_sha256: string }>;
  attempts: number; replayed: boolean; virtual_ms: number; result_hash: string;
}

export interface Hypothesis { label: string; score: number; status: "ACTIVE" | "LEADING" | "REJECTED" | "SUPPORTED"; supporting: string[]; refuted_by?: string[]; note?: string }
/** Provenance of a model-produced decision: hashes only, never the prompt or reply text. */
/** Credential-free identity of the provider/model that produced one decision, as reported by the SakthiAI Provider Gateway. Absent = UNVERIFIED. */
export interface ModelProvenance {
  provider_id: string; model_id: string; profile_id: string; provider_kind: string; billing_mode: string; config_source: string;
  usage_source: string; latency_ms: number;
  runtime_class?: string; endpoint_profile?: string; invoked_at?: string; correlation_id?: string; verification?: string; fallback_occurred?: boolean; cost?: { amount: number; unit: string; estimated: boolean };
  gateway_attempts: Array<{ provider_id: string; outcome: string; http_attempts?: number; latency_ms?: number }>;
}
export interface ModelMeta { reasoning_chars?: number; prompt_sha256: string; response_sha256: string; attempt: number; model_calls: number; tokens_in?: number; tokens_out?: number; transport: string; provenance?: ModelProvenance }
export type Decision =
  | { type: "CALL"; request: ToolRequest; rationale: string; hypotheses: Hypothesis[]; model_meta?: ModelMeta }
  | { type: "FINAL"; final: FinalAnswer; hypotheses: Hypothesis[]; model_meta?: ModelMeta };
export interface FinalAnswer {
  outcome: "DIAGNOSIS" | "ABSTAIN"; label: string; summary: string; cited: string[];
  contradictions: Array<[string, string]>; confidence: number;
  remediation: { text: string; executed: boolean; requires_approval: boolean };
  next_safe_steps: string[]; abstain_reason?: string;
}
export interface PolicyView {
  case: CaseDoc; history: ToolResult[]; calls_left: number; steps_left: number; virtual_ms_left: number;
  force_final: boolean; taxonomy: Record<string, string>;
}
export interface Policy { id: string; kind: "deterministic_stub" | "llm"; next(view: PolicyView): Decision }

/** Policy whose decision may be asynchronous (model call). Same trust level as Policy: untrusted. */
export interface AsyncPolicy { id: string; kind: "deterministic_stub" | "llm"; /** shown in run_start, e.g. that the transport is a mock */ note?: string; next(view: PolicyView, signal?: AbortSignal): Decision | Promise<Decision> }

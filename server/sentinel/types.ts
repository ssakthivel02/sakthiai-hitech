import type { Limits, READ_TOOLS } from "./engine/types";

export type ReadTool = (typeof READ_TOOLS)[number];

export const INVESTIGATION_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "ABSTAINED", "FAILED", "CANCELLED"] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];
export const TERMINAL_STATUSES: readonly InvestigationStatus[] = ["COMPLETED", "ABSTAINED", "FAILED", "CANCELLED"];
export const isTerminalStatus = (s: InvestigationStatus): boolean => TERMINAL_STATUSES.includes(s);

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Maps one Sentinel read tool onto one MCP tool of one workspace connector. Stored on the investigation, validated at creation and re-checked
 * by McpConnectorService on every call (enabled connector, discovered tool, read-only decision, allowlist). Bindings can name only read tools.
 */
export interface DiagnosticBinding {
  tool: ReadTool;
  connectorId: string;
  mcpTool: string;
  /** MCP argument that receives the inventory target (service/host name) */ targetParam: string;
  /** MCP argument that receives args.query, if the tool supports it */ queryParam?: string;
  /** MCP argument that receives args.window_min, if the tool supports it */ windowParam?: string;
  /** constant extra arguments (never model-controlled) */ fixedArgs?: Record<string, string | number | boolean>;
}

export interface InvestigationRecord {
  id: string;
  workspaceId: number;
  createdByUserId: number;
  taskId: string | null;
  title: string;
  severity: Severity;
  service: string;
  firedAt: string;
  description: string;
  objective: string;
  operatorNotes: string[];
  inventory: { services: string[]; hosts: string[] };
  allowedTools: ReadTool[];
  limits: Limits;
  bindings: DiagnosticBinding[];
  status: InvestigationStatus;
  /** engine stop reason once finished (POLICY_FINAL, CANCELLED, POLICY_ERROR, ...) */ stopReason: string | null;
  outcome: "DIAGNOSIS" | "ABSTAIN" | null;
  label: string | null;
  confidence: number | null;
  /** engine verifier accepted the final answer (structural/evidence checks; see report.verification) */ verified: boolean | null;
  traceHead: string | null;
  eventCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One persisted, hash-chained trace event (same shape the engine produces). */
export interface StoredEvent { seq: number; type: string; vt: number; payload: unknown; prev: string; hash: string }

export const AUDIT_ACTIONS = ["CREATE", "CANCEL_REQUESTED", "EXPORT_REPORT", "DELETE"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
/** API-level lifecycle audit (who did what). Execution itself is audited by the hash-chained event trace and the MCP connector audit log. */
export interface AuditEntry { id: number; investigationId: string; workspaceId: number; actorUserId: number; action: AuditAction; detail: string | null; createdAt: Date }

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hypothesis, ToolRequest, ToolResult } from "./types";
import type { TraceEvent } from "./trace";
import { canon } from "./canon";

/** Everything needed to continue an investigation after a crash. JSON-serialisable by construction. */
export interface Checkpoint {
  v: 1; case_id: string; policy_id: string; policy_kind: string;
  /** last step started (AWAIT_TOOL: the step whose tool call is pending) */ step: number;
  phase: "AWAIT_DECISION" | "AWAIT_TOOL";
  pending: { step: number; request: ToolRequest } | null;
  results: ToolResult[]; trace: TraceEvent[]; trace_head: string;
  hypothesis_history: Array<{ step: number; hypotheses: Hypothesis[] }>;
  resumes: number;
}
export interface SealedCheckpoint { checkpoint: Checkpoint; mac: string }
export class CheckpointError extends Error {
  readonly code: string;
  constructor(code: string, detail = "") { super(detail ? `${code}: ${detail}` : code); this.name = "CheckpointError"; this.code = code; }
}

const macOf = (cp: Checkpoint, key: string | Buffer): string => createHmac("sha256", key).update(canon(cp)).digest("hex");

/**
 * Authenticate a checkpoint with a key that storage does not hold. The hash chain alone only detects accidental edits:
 * anyone who can write storage can recompute it. The MAC is what makes a forged-but-consistent checkpoint detectable.
 */
export function sealCheckpoint(cp: Checkpoint, key: string | Buffer): SealedCheckpoint {
  if (!key || key.length < 16) throw new CheckpointError("KEY_TOO_SHORT", "checkpoint key must be at least 16 bytes");
  return { checkpoint: cp, mac: macOf(cp, key) };
}
export function openCheckpoint(sealed: SealedCheckpoint, key: string | Buffer): Checkpoint {
  if (!sealed || typeof sealed !== "object" || typeof sealed.mac !== "string" || !sealed.checkpoint) throw new CheckpointError("MALFORMED");
  if (!key || key.length < 16) throw new CheckpointError("KEY_TOO_SHORT");
  const want = Buffer.from(macOf(sealed.checkpoint, key), "hex"), got = Buffer.from(sealed.mac, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new CheckpointError("MAC_MISMATCH", "checkpoint was not produced by a holder of the key, or was modified");
  return sealed.checkpoint;
}

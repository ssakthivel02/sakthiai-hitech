import type { World, WorldObs } from "./types";

/** One read-only diagnostic call outcome. `virtual_ms` is the accounting unit the broker budgets against (wall milliseconds in production). */
export type BackendOutcome = { kind: "ok"; obs: WorldObs[]; virtual_ms: number } | { kind: "timeout"; virtual_ms: number } | { kind: "error"; virtual_ms: number; code: string };
export interface ExecOpts { signal?: AbortSignal; args?: Record<string, unknown> }
/**
 * Contract every diagnostic adapter implements. It can only READ: the broker never routes a write tool to it, and an adapter must never
 * expose one. `tenant` is supplied by the trusted caller (the task's workspace), never by the model.
 */
export interface ToolTransport { exec(tenant: string, tool: string, target: string, opts?: ExecOpts): BackendOutcome | Promise<BackendOutcome> }
export type { World, WorldObs };

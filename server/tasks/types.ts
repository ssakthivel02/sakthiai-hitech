export const TASK_STATES = ["QUEUED", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_STATES: readonly TaskState[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
export type TaskFailureClass = "RETRYABLE" | "NON_RETRYABLE" | "PROVIDER_UNAVAILABLE" | "BUDGET_DENIED" | "POLICY_DENIED" | "LEASE_EXPIRED" | "INTERNAL";

export type TaskRecord = {
  id: string;
  workspaceId: number;
  createdByUserId: number | null;
  type: string;
  state: TaskState;
  idempotencyKey: string | null;
  input: unknown;
  checkpoint: unknown | null;
  checkpointSeq: number;
  progressPercent: number | null;
  progressNote: string | null;
  result: unknown | null;
  attempt: number;
  maxAttempts: number;
  retryAfter: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  cancelRequested: boolean;
  failureClass: TaskFailureClass | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** Public projection: never exposes lease internals or the raw input of other features' tasks beyond what callers own. */
export type TaskView = Pick<TaskRecord, "id" | "workspaceId" | "type" | "state" | "checkpointSeq" | "progressPercent" | "progressNote" | "result" | "attempt" | "maxAttempts" | "cancelRequested" | "failureClass" | "errorMessage" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt">;

export class TaskIdempotencyConflict extends Error { constructor() { super("idempotency key reused with a different task"); this.name = "TaskIdempotencyConflict"; } }
export class TaskLeaseLostError extends Error { constructor() { super("task lease lost"); this.name = "TaskLeaseLostError"; } }
export class TaskCancelledError extends Error { constructor() { super("task cancelled"); this.name = "TaskCancelledError"; } }
export class TaskRetryableError extends Error {
  constructor(message: string, readonly failureClass: TaskFailureClass = "RETRYABLE", readonly backoffMs?: number) { super(message); this.name = "TaskRetryableError"; }
}
export class TaskFatalError extends Error {
  constructor(message: string, readonly failureClass: TaskFailureClass = "NON_RETRYABLE") { super(message); this.name = "TaskFatalError"; }
}

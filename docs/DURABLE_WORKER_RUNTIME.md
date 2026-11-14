# Durable worker runtime (Package 0016)

Status: SOURCE_IMPLEMENTED, LOCALLY_TESTED (MariaDB 10.11). CI_PENDING. RUNTIME_UNVERIFIED.

## What is wired
- `TaskWorkerRuntime` (`server/tasks/runtime.ts`): N slot loops, each a `TaskWorker` with its own owner id. Bounded concurrency (1–8, default 2).
- Started from `server/_core/index.ts` after `listen`; **OFF unless `TASK_WORKER_ENABLED=true`**.
- SIGTERM/SIGINT: stop claiming, drain in-flight up to `TASK_WORKER_SHUTDOWN_GRACE_MS`, then `server.close()`. Tasks still running after the grace are *abandoned*: lease renewal stops, the handler's next `ctx` call fails with `TaskLeaseLostError` (no store write), and another runtime resumes from the last checkpoint after lease expiry.
- Failures (store outage, handler error) are caught, sanitised, backed off; they never reach the HTTP process. `healthy=false` after 5 consecutive errors.
- `/readyz` → `dependencies.taskWorker` (informational; does not change the 200/503 decision).
- One workflow: `chat.answer` (retrieve → Provider Gateway → persist), enqueued by `chat.sendAsync`, polled via `tasks.get`. `chat.send` is unchanged.

## Config
`TASK_WORKER_ENABLED` (default false), `TASK_WORKER_CONCURRENCY` (2), `TASK_WORKER_POLL_MS` (1000), `TASK_WORKER_LEASE_MS` (30000), `TASK_WORKER_SHUTDOWN_GRACE_MS` (15000). Invalid values fall back to defaults.

## Invariants (tested on real SQL)
- Tenant = `task.workspaceId`, never the payload; conversation must belong to that workspace *and* user, else fatal non-retryable.
- Question and answer persistence are `ctx.effect`s: retries/resumes never duplicate messages.
- Budget/policy refusal → fatal, no retry, provider not contacted → truthful `MODEL_UNAVAILABLE` recorded (evidence still shown). Transient outage → retried with backoff up to `maxAttempts`, then `MODEL_UNAVAILABLE`.
- Two runtimes racing: exactly one effective execution per task.

## Gotchas
- Effects are at-least-once with durable dedupe; a crash between effect and record repeats it.
- In-process worker only; scaling out = more app instances (safe: leases + fencing).
- With the flag off `chat.sendAsync` returns PRECONDITION_FAILED.

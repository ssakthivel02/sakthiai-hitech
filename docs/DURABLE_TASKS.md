# Durable task execution

`server/tasks` is the provider-neutral execution substrate for long-running work (agents, research, ingestion, creator pipelines later). State lives in MySQL (`durableTasks`, `durableTaskEffects`, migration 0008); any worker instance can resume any task.

Lifecycle: `QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED`, with `WAITING` for backed-off retries. Claiming is an atomic conditional UPDATE; a lease (default 30 s, heartbeat at 1/3) is renewed while the handler runs. Every worker write is fenced by `(leaseOwner, attempt)`, so a worker whose lease was taken over cannot checkpoint, complete or fail. A crashed worker never yields success: the lease expires, another worker resumes from the last durable checkpoint, and a task out of attempts becomes `FAILED/LEASE_EXPIRED`.

Retry: `TaskRetryableError` (and unknown errors, class INTERNAL) back off exponentially up to `maxAttempts` (<=10); `TaskFatalError` fails at once. Model calls go through `ctx.invokeModel`, which pins the tenant to the task's workspace and uses the Provider Gateway on every attempt: budget/policy refusals and caller faults are fatal (`BUDGET_DENIED`, `POLICY_DENIED`, `NON_RETRYABLE`), outages are retryable `PROVIDER_UNAVAILABLE`; failure messages carry only the provider-neutral reason.

Idempotency: `create({idempotencyKey})` is unique per workspace (same payload returns the same task; different payload -> conflict). `ctx.effect(key, fn)` replays a completed side effect from its durable record on retry/resume (at-least-once: a crash between `fn` and its record repeats it, so use idempotent operations).
Cancel is durable: queued/waiting tasks cancel at once; running tasks stop at their next checkpoint; cancelled tasks of dead workers are finalised on the next claim.
Access: tRPC `tasks.get/list/cancel` require workspace membership; a task id from another workspace is NOT_FOUND. There is deliberately no public enqueue endpoint: server features enqueue typed work.
Start a worker in-process with `new TaskWorker({ store, handlers, gateway }).start()`; nothing starts one automatically yet.

# SakthiAI Agent Workbench — implementation specification (2026-10-20)

Status: PROPOSAL / NOT IMPLEMENTED. Branch only; no production changes.

## Competitive inputs
Kimi Work: local files, WebBridge browser operation, phone remote control, skills, dashboards, scheduled tasks, agent swarms.
ChatGPT Work: connected apps, cloud computer, event/scheduled workflows.
Claude Code: hooks, scoped subagents, skills, repository engineering.
Codex: isolated cloud coding environments and remote task management.

## Build order
P0: inspect existing gateway, auth, migrations, cost controls, worker model, CI and draft PR #29. Do not duplicate modules.
P1: task/run API with tenant-scoped IDs, states queued/running/awaiting_approval/paused/succeeded/failed/cancelled, idempotency keys, durable checkpoints and append-only audit events.
P2: policy engine with explicit allowlisted tools, default-deny network/filesystem, approval records tied to action hash and expiry, per-workspace quotas and reserve-before-call budget accounting.
P3: versioned skill registry with signed manifests, permission declarations, review, rollback and per-workspace enablement.
P4: durable scheduled jobs with timezone/DST semantics, missed-run policy, concurrency caps, retries and dead-letter queue.
P5: isolated browser worker (Playwright), SSRF/private-network protection, domain allowlists, artifact redaction, human confirmation for external side effects.
P6: mobile task console for viewing status and approving specific action digests; no direct arbitrary remote shell.
P7: optional local desktop companion with per-folder grants, ephemeral credentials, revocation and device binding.
P8: bounded multi-agent orchestration (initial cap 2-4), explicit DAG dependencies, budgets and deterministic termination.
P9: Tamil/English benchmarks, voice interfaces only after privacy and quality review.

## Minimum API contract (proposal)
POST /api/agent/tasks (idempotency-key, workspace, skill, inputs)
GET /api/agent/tasks/:id
POST /api/agent/tasks/:id/cancel
POST /api/agent/tasks/:id/approvals/:approvalId (decision, actionDigest)
GET /api/agent/tasks/:id/events
All routes require authentication, tenant authorization and rate limits.

## Non-negotiable tests
- Cross-tenant read/write denial
- Duplicate idempotency key cannot double-charge or double-execute
- Expired/replayed/mismatched approvals rejected
- Tool execution denied without capability grants
- Prompt-injection text cannot elevate tool permissions
- Browser worker cannot reach metadata/private networks
- Job retries and cancellation never double-commit external actions
- Provider failure reconciles reserved spend correctly
- Queue restart recovers safely from checkpoint
- Audit logs redact secrets and sensitive file contents
- CI checks, migrations and rollback demonstrated

## Release policy
No merge, production deployment, paid inference, database power-on or secret changes in this workstream. Deliver each phase as an independently reviewable draft PR with passing tests and cost evidence.

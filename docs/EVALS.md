# Contract evals (`pnpm evals`)

Deterministic CONTRACT / EVAL HARNESS evidence. It drives the real `chat.send` procedure, retrieval ranking,
grounding resolution and Provider Gateway against fixed fixtures with replayed provider responses.

- No secrets, no network, no paid provider calls (provider env vars are stripped; a fetch guard asserts nothing escapes).
- It proves routing, policy, grounding-state, citation, isolation and failure-handling contracts. It does **not**
  measure real-model answer quality (`realModelQuality: NOT_MEASURED`) and does not make the competitive
  CORE_AI_BENCHMARK scorecard complete.
- Persistence is an in-memory tenant-filtered stand-in for `db.searchChunks`; real-database isolation is not proven here.
- Exit code is non-zero on any threshold regression (see `THRESHOLDS` in `server/evals/metrics.ts`).
- Report: `reports/evals/eval-report.json` (uploaded by the Quality Gate as `eval-report`).
- Product truth: `SAKTHIAI_CAPABILITY_IMPLEMENTATION_MAP.json` (validated by `server/evals/capabilityMap.test.ts`).

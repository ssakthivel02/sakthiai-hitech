# Resumable quarantined file ingestion

Status: **SOURCE_IMPLEMENTED / LOCALLY_TESTED (MariaDB 10.11) / CI_PENDING / RUNTIME_UNVERIFIED**. Backend only: the upload UI stays disabled behind the owner-approval gate.

## API (tRPC, workspace-scoped, authenticated)
`files.resumable.begin` -> `putChunk` (any order, idempotent) -> `status` (received/missing, for resume) -> `finalize` | `abort`.
Off unless `FILE_INGESTION_BACKEND_ENABLED=true` (otherwise FORBIDDEN, nothing written). The legacy `files.upload` is untouched.

## Pipeline (finalize)
assemble (memory only) -> size + SHA-256 vs declared -> extension/magic check -> **malware scan** -> clean decision -> extraction -> normal storage.

| Outcome | Result | Bytes |
|---|---|---|
| clean + extractable | document created, one object-store write | quarantine purged |
| size/checksum/shape mismatch | REJECTED | purged, scanner never called |
| infected | REJECTED (terminal; cannot be revived) | purged |
| scanner unavailable / not configured / error | 503, upload returns to OPEN | stay quarantined; finalize can be retried |
| extraction failure / duplicate content | REJECTED | purged |
| transient storage/DB failure | OPEN again; half-written document rolled back | stay quarantined |

## Invariants (all tested on real SQL)
- Raw bytes exist only in `fileUploadChunks`; nothing in documents/retrieval/object storage is written before CLEAN + extraction. `extractDocument` is additionally given a scanner that vouches only for the exact SHA-256 already scanned.
- All state changes are conditional UPDATEs; exactly one concurrent finalizer wins; DB clock for expiry.
- Sessions are scoped by (workspaceId, userId); foreign sessions are NOT_FOUND for every operation.
- Chunks: exact size, in-range index, optional per-chunk checksum; same index + different content = CONFLICT; duplicates are idempotent.
- Limits: 12 MiB file, 4-128 KiB chunks (stays under the 256 KiB edge body limit), 4 active uploads and 36 MiB staged bytes per user, 1 h TTL.

## Operations / gotchas
- `UploadStore.cleanup()` expires stale uploads, recovers FINALIZING sessions whose finalizer died (>5 min), purges chunks of terminal sessions and orphans, and deletes terminal rows after 7 days. A **bounded, default-OFF scheduled runner** now calls it (see below).
- Quarantine bytes live in the application database (mediumblob). Size the DB accordingly or move the quarantine to a separate store later.
- Runtime qualification still requires a real ClamAV (clean, EICAR, outage) per `docs/FILE_MALWARE_GATE.md`.

## Scheduled cleanup runner (Package 0018)
`UploadCleanupRunner` (`server/ingestion/cleanupRunner.ts`) is started by the server after `listen` and stopped on SIGTERM/SIGINT. **OFF unless `UPLOAD_CLEANUP_ENABLED=true`.** It does NOT enable uploads: those stay behind `FILE_INGESTION_BACKEND_ENABLED` + the scanner gate, and production default remains "Coming Soon" (no client change was made).
- Config: `UPLOAD_CLEANUP_INTERVAL_MS` (600000), `UPLOAD_CLEANUP_BATCH_LIMIT` (200), `UPLOAD_CLEANUP_MAX_BATCHES` (10 per run), `UPLOAD_CLEANUP_RETENTION_DAYS` (7), `UPLOAD_CLEANUP_FINALIZING_STALE_SECONDS` (300). Invalid values fall back to defaults.
- Bounded: each pass touches at most `batchLimit` rows per statement; a run does at most `maxBatchesPerRun` passes; leftovers wait for the next interval (`truncated` in status/log).
- Single-flight per process: an overlapping tick is skipped (`skippedBusy`). Across processes the statements are conditional and idempotent, so concurrent runners are safe (tested).
- Deletes only quarantine rows/bytes of terminal (COMPLETED/REJECTED/EXPIRED/ABORTED) or orphaned uploads and terminal session rows past retention. Never OPEN or fresh FINALIZING uploads; never `documents`, `documentChunks` or object storage.
- Status: `/readyz` -> `dependencies.uploadCleanup` (state, runs, skippedBusy, totals, lastRunAt, lastDurationMs, lastTruncated, healthy after <3 consecutive errors) plus one JSON log line per run (counts only). Informational; does not affect the 200/503 decision.
- Gotcha: if migration 0010 is not applied the runner reports errors (unhealthy) but never crashes the app.

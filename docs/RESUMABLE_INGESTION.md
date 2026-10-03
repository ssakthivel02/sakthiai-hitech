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
- `UploadStore.cleanup()` expires stale uploads, recovers FINALIZING sessions whose finalizer died (>5 min), purges chunks of terminal sessions and orphans, and deletes terminal rows after 7 days. **No scheduler is wired yet**; run it from an operator job.
- Quarantine bytes live in the application database (mediumblob). Size the DB accordingly or move the quarantine to a separate store later.
- Runtime qualification still requires a real ClamAV (clean, EICAR, outage) per `docs/FILE_MALWARE_GATE.md`.

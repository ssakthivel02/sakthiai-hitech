# Backup / restore / rollback rehearsal (local)

Status: **SOURCE_IMPLEMENTED / LOCALLY_TESTED (MariaDB 10.11) / CI_PENDING / RUNTIME_UNVERIFIED**. Evidence class `LOCAL_REHEARSAL`.

Run: `TEST_DATABASE_URL=mysql://user:pw@127.0.0.1:3306 pnpm test:recovery` (throwaway local server only). Output: `reports/recovery/recovery-report.json`.

## Safety
Managed hosts (Aiven, Render, RDS, Azure) are refused; non-loopback hosts are refused unless `MYSQL_TEST_ALLOW_REMOTE=1` for a disposable server. Only `sakthi_rr_*` / `sakthi_it_*` scratch databases are ever dropped. Nothing here touches Aiven or any production database.

## What is rehearsed
1. Full cycle at the latest schema (all migrated tables, binary + Tamil data, AUTO_INCREMENT counters) -> backup file -> restore into an EMPTY database -> per-table row count + SHA-256 verified.
2. Refusals: non-empty target, the source database, tampered/truncated backup, schema newer than this build, managed hosts. Nothing is written when refused.
3. Interrupted restore is reported as failed; verification flags the half-built target; procedure = discard and retry into a new database.
4. Upgrade: an OLD-schema (0005) backup is restored, forward migrations bring it to latest, original columns hash identically, `searchText` backfill is complete and idempotent, and the schema equals a freshly migrated database.
5. Provider policy / budget counters / usage holds survive a restore and still enforce the same limits.
6. Durable tasks: a retrying task resumes from its checkpoint after a restore and does not repeat its recorded effect.
7. OAuth login transactions: live rows consume exactly once, replays/expired are refused, cleanup removes only expired rows.
8. Bad-migration rollback: damage is detected against the pre-migration manifest, a verified copy is restored from the backup file.

## Rollback truth
Migrations are **forward-only**. There is no schema downgrade and the rehearsal never claims one. Rollback = restore the pre-migration backup into a fresh database, verify, switch the app, and accept that writes after the backup are lost (RPO = backup age). Application rollback is a separate redeploy of the previous known-good commit (`docs/PREVIEW_ROLLBACK_RUNBOOK.md`).

## Not verified here (do before production)
Managed-database backups and point-in-time recovery, real data volumes and RTO/RPO, object-storage restore (files referenced by `storageKey`), MySQL 8 (CI-pending), and any scheduled/automated backup job.

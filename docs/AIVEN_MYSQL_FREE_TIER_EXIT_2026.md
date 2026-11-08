# SakthiAI preview MySQL — 2026 free-tier exit and verified recovery

**Status:** operator runbook / NOT EXECUTED / NO RESTORE PROOF. **Owner approval required for each live step.**

**Related:** [data-preservation issue #46](https://github.com/ssakthivel02/sakthiai-hitech/issues/46), [database-recovery policy](./DATABASE_RECOVERY_READINESS.md), [local recovery rehearsal](./RECOVERY_REHEARSAL.md), [integration gates](./INTEGRATION_RUNTIME_QUALIFICATION.md).

## Purpose and known facts

The account owner reported an Aiven notice dated 6 November 2026 announcing free MySQL retirement on **21 December 2026**, with eventual loss of hosted data and backups. Confirm the exact service applicability and deadlines from the private notice; do not depend on a post-retirement grace period.

Read-only service metadata observed on 8 November 2026:

| Field | Observation |
| --- | --- |
| Existing service | `hitech-preview-mysql` in Aiven project `ssakthivel02-7661` |
| Engine / region | MySQL **8.4.8** / `do-blr` |
| Plan / state | `free-1-1gb` / **POWEROFF** |
| Hosted backup metadata | Listed through 3 November 2026; **no independent export or restore verified** |
| Existing app preview | Render `sakthiai-hitech-preview` suspended, auto-deploy OFF |

The application uses MySQL via Drizzle. A PostgreSQL migration is a code/schema/driver project, not an administrative plan switch. MySQL-to-MySQL is the short-term compatibility-first route. Aiven provider backup metadata is **not** evidence that a usable off-platform copy exists.

**Deadline:** target a privately retained, test-restored export before **1 December 2026**, well ahead of reported retirement. This is a planning target, not an approval to modify the service.

## Immutable safety requirements

1. No new service, plan upgrade, source/production database write, service power-on, restore, credential change, or Render resume without a separate recorded owner approval. Keep provider generation and deployment OFF.
2. Operate only on the named preview database `sakthiai_preview`; never substitute `sakthiai_production`, the admin database, or a guessed name.
3. Never put a database dump, sample row, SQL data, connection string, access key, backup key, private bucket listing, account email, or service credential into this public repository, GitHub issues, CI logs or public artifacts.
4. Use a **read-only export account** with the minimum SELECT/SHOW VIEW/TRIGGER/EVENT/SHOW ROUTINE grants actually required by the dump. Do not grant DROP or schema-changing privileges. Preserve TLS certificate verification and check the endpoint host.
5. Record exact source/target service identities out of band. Refuse to run if identities, backup integrity, target isolation, owner permission or TLS checks are unknown.
6. Keep the existing Aiven service and hosted backups unchanged until a separately verified recovery copy exists. Do not automate deletion after export.

## A — Before starting the service

- [ ] Owner authorizes a limited power-on/export window and cost/plan boundaries.
- [ ] Record the current Aiven plan, state, region, MySQL version, expected database and latest provider backup timestamp privately; confirm the provider-managed backup still exists.
- [ ] Confirm `sakthiai-hitech-preview` remains **suspended** and cannot write during the snapshot.
- [ ] Choose a private encrypted off-platform backup destination (and separate retained encryption key); establish access, retention period and available space.
- [ ] Select a current MySQL 8.4-compatible client installed on a controlled operator machine. Do not use a public GitHub runner.
- [ ] Prepare a dedicated read-only Aiven export principal, TLS root CA and a protected client option file. Host/port, account password and CA path must be captured outside Git.
- [ ] Record application schema journal identity, source snapshot instant and any objects that cannot be exported transactionally; account for concurrent DDL and non-InnoDB tables.

No backup is complete merely because an Aiven dashboard shows a timestamp.

## B — Private operator logical export (example; **do not execute without approval**)

On the approved operator machine, use a mode-0600 MySQL options file such as `/private/path/source.cnf`, with verified host, user, password, port, `ssl-mode=VERIFY_IDENTITY` and `ssl-ca`. Check the selected MySQL client supports the options and the Aiven endpoint certificate matches the actual host before connecting. Do not echo or commit the file.

In a private terminal, after independently verifying the target is **source preview only**:

```bash
set -euo pipefail
umask 077
SOURCE_CNF=/private/path/source.cnf
OUT_DIR=/private/encrypted-workspace/sakthiai-preview-export
mkdir -p "$OUT_DIR"

# --defaults-extra-file MUST be the first mysqldump option.
# A frozen-write window is preferable; --single-transaction covers transactional tables,
# not an arbitrary concurrent DDL/schema change.
mysqldump --defaults-extra-file="$SOURCE_CNF" \
  --single-transaction --quick --skip-lock-tables --no-tablespaces \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 \
  --hex-blob --triggers --routines --events \
  --databases sakthiai_preview \
  | gzip -c > "$OUT_DIR/sakthiai-preview.sql.gz"

test -s "$OUT_DIR/sakthiai-preview.sql.gz"
gzip -t "$OUT_DIR/sakthiai-preview.sql.gz"
sha256sum "$OUT_DIR/sakthiai-preview.sql.gz" > "$OUT_DIR/sakthiai-preview.sql.gz.sha256"
```

If the export lacks required permissions for stored routines or other schema objects, STOP and assess the missing scope; do not silently omit objects or switch to a broad admin account. Treat both the compressed dump and hash as confidential operator artifacts; **encrypt the dump and move it off the Aiven service and operator host** using an approved mechanism, then verify the encrypted copy can be read. SHA-256 verifies a particular file; it does not prove its contents can be restored.

Record privately: exact source service, MySQL version, dump client/version/options, database name, source export time UTC, backup ID/time if available, byte size, plaintext digest, encryption identifier and destination, and operator approval.

## C — Independently verify recovery in an isolated target

1. Obtain separate approval for a **disposable, isolated scratch MySQL service**. Never restore over the current Aiven preview or any production database. Require a clearly named, empty scratch instance with independent TLS and scoped importer access.
2. Verify the scratch endpoint's identity in a separate connection profile and confirm the target has no valuable existing data.
3. Restore the approved export into the scratch instance only; the `--databases` dump includes the source database name, so the scratch service must be isolated. Do not edit or replay SQL until this is approved.
4. Validate a full restore exit code and compare the migration journal (ordered IDs and hashes), table/view/routine/trigger/event inventory, per-table row counts, key constraints, and representative UTF-8/Tamil text values against source-side **private** evidence.
5. Run read-only application-domain smoke tests against the scratch target using temporary authorized identities; verify workspaces/projects, Creator entities and durable task/budget state are preserved.
6. Verify media artifacts **separately** from database contents: inventory S3-compatible objects referenced by storage keys and compare object size/digest where supported. SQL-only recovery does not reconstruct images, audio or video.
7. Record a tested restore time, observed RPO/RTO, failures and approved rollback path. An incomplete or diverging restore means **NO-GO**.
8. Keep the restored target isolated. Switching the Render application to it requires a separately authorized release plan.

Do not use the local MariaDB recovery rehearsal as proof that the managed MySQL 8.4 export is restorable.

## D — Hosting decision

**Preferred minimum-change path:** a MySQL 8.4-compatible managed instance, restoring the tested export and object storage. Compare actual capacity, TLS/CA, region, backups/PITR, access isolation and monthly cost before deciding.

**Temporary bridge:** a separately approved paid Aiven MySQL plan on the existing service, only after confirming provider policy, preservation terms and cost. An upgrade alone is not an independent backup.

**Deferred migration:** PostgreSQL, after assessing Drizzle schema dialect, SQL migrations, drivers, query semantics, full-text search, transactional and charset differences, and running application regression tests. Do not use it as an emergency one-click switch.

## E — Final evidence and stop/go

- [ ] Reported deadline and the affected service independently confirmed.
- [ ] Source database and object-storage backups exported to **encrypted independent storage**.
- [ ] Both dumps and encrypted files pass integrity checks; immutable hashes recorded.
- [ ] Scratch restore **actually succeeds** and schema/data/journal comparisons pass.
- [ ] Media/object recovery is separately tested or explicitly documented as a blocking gap.
- [ ] Recovery runbook and new database hosting plan approved.
- [ ] A later exact-head application rollout passes `/releasez`, `/healthz`, `/readyz` and authenticated Creator tests before release.
- [ ] Old service shutdown is separately approved only after the new path works.

**Current conclusion (8 November 2026):** documentation and read-only Aiven metadata only. The data-preservation task is **OPEN**; no power-on, export, restore, plan change or paid operation has been executed.

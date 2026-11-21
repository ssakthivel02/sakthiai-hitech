# SakthiAI preview MySQL — 2026 free-tier exit and verified recovery

**Status:** operator runbook / NOT EXECUTED / NO RESTORE PROOF. **Owner approval required for each live step.**

**Related:** [data-preservation issue #46](https://github.com/ssakthivel02/sakthiai-hitech/issues/46), [database-recovery policy](./DATABASE_RECOVERY_READINESS.md), [local recovery rehearsal](./RECOVERY_REHEARSAL.md), [integration gates](./INTEGRATION_RUNTIME_QUALIFICATION.md).

## Purpose and known facts

Aiven's public MySQL free-tier migration documentation and retirement changelog independently confirm that remaining free MySQL services are scheduled to be powered off on **21 December 2026**, with associated data/backups removed and no self-service recovery afterward. Vendor references: https://aiven.io/docs/products/mysql/howto/mysql-free-tier-migration-options and https://aiven.io/changelog/507f8b1b-dd8f-4841-ac4a-940ac492b688 . Treat this as a hard preservation deadline; do not depend on a post-retirement grace period.

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

## Shared-service preservation scope — verified 12 November 2026

**P0 correction:** the single Aiven MySQL service is shared by multiple projects. A read-only Aiven service inventory on 9 November listed four existing database names. On 12 November the live project service listing shows the MySQL service **POWEROFF**; this is a state observation, not permission to restart it. The 9 November provider backup metadata included a MySQL backup timestamp `2026-11-09T05:32:47.380313Z`, but there is **no evidence of an independent exported, encrypted and test-restored copy**.

| Database on `hitech-preview-mysql` | Preservation action | Restore acceptance |
| --- | --- | --- |
| `sakthiai_preview` | Required, approved read-only logical export | SakthiAI migration journal/schema, tenant and Creator integrity |
| `kirthiverse_preview` | Required unless its owner documents safe retirement | Independently confirm KirthiVerse schema/lesson/quiz counts and UTF-8/Tamil data |
| `ramaverse_preview` | Required unless its owner documents safe retirement | Independently confirm RamaVerse corpus, provenance and text integrity |
| `defaultdb` | **Unknown contents: inspect ownership and inventory first**; never presume empty/disposable | Document table count and disposition; include in export/restore if it contains project data |

The scope of a service-retirement backup is **every retained user/application database** plus relevant media/object storage, not only the database consumed by the SakthiAI release. Do not claim an entire-service recovery or delete/upgrade the service based solely on a successful `sakthiai_preview` export.

For each database, use its **verified, separately authorized** read-only identity and a separate compressed encrypted dump, integrity manifest, storage location and independent restore result. Avoid blanket global MySQL grants, uncontrolled `--all-databases` exports, and dumps to public GitHub runners or artifacts. Coordinate KirthiVerse and RamaVerse lanes with their existing owners/factories; **do not create duplicate issues, repos or migration jobs**. Cross-database consistency matters if services reference one another: a single-database `--single-transaction` snapshot is not proof of a shared atomic snapshot across multiple separate dump invocations. Quiesce writes or plan coordinated snapshot evidence when required.

**Operator go/no-go:** if any retained database lacks an independent export and successful isolated restore, the Aiven MySQL free-tier exit remains **OPEN**. A paid MySQL tier may be a temporary retention bridge but does not replace portable recovery proof.

## Immutable safety requirements

1. No new service, plan upgrade, source/production database write, service power-on, restore, credential change, or Render resume without a separate recorded owner approval. Keep provider generation and deployment OFF.
2. Treat `sakthiai_preview` as the SakthiAI release-inspection target, **not** as the full MySQL service preservation scope. Export each separately approved, verified application database from the shared service; never substitute `sakthiai_production`, connect to an unverified server, or use a guessed name. Do not combine unrelated databases into the SakthiAI migration/restore gate.
3. Never put a database dump, sample row, SQL data, connection string, access key, backup key, private bucket listing, account email, or service credential into this public repository, GitHub issues, CI logs or public artifacts.
4. Use a **read-only export account** with the minimum SELECT/SHOW VIEW/TRIGGER/EVENT/SHOW ROUTINE grants actually required by the dump. Do not grant DROP or schema-changing privileges. Preserve TLS certificate verification and check the endpoint host.
5. Record exact source/target service identities out of band. Refuse to run if identities, backup integrity, target isolation, owner permission or TLS checks are unknown.
6. Keep the existing Aiven service and hosted backups unchanged until a separately verified recovery copy exists. Do not automate deletion after export.

## A — Before starting the service

### Network-exposure gate before any recovery power-on

The 21 Nov 2026 read-only Aiven metadata shows the powered-off service's configured IP filter currently includes both `0.0.0.0/0` and `::/0`. This is a broad network allowlist. It is **not evidence of unauthenticated access**, and the service is currently POWEROFF, but it is not an acceptable default assumption for a controlled export window.

Before any separately authorized power-on:
- obtain explicit owner/security approval for the intended network path;
- restrict ingress to the minimum approved export-client source(s), private network, or another provider-supported controlled access path **before exposing the running database**;
- preserve TLS identity verification and least-privilege export credentials;
- record the temporary access-control change and rollback plan privately;
- restore the approved secure posture after the export window.

Do **not** power on first and rely on password authentication alone while the broad allowlist remains configured. Any IP-filter change is itself a live infrastructure mutation and requires separate `AUTHORIZE_AIVEN_ACTION` / owner approval; this runbook does not execute it.


- [ ] Owner authorizes a limited power-on/export window and cost/plan boundaries.
- [ ] Record the current Aiven plan, state, region, MySQL version, expected database and latest provider backup timestamp privately; confirm the provider-managed backup still exists.
- [ ] Privately inventory every database on the shared MySQL service, confirm each project owner and preservation/retirement decision, and explicitly include any retained `defaultdb` data.
- [ ] Confirm `sakthiai-hitech-preview` remains **suspended** and cannot write during the snapshot.
- [ ] Choose a private encrypted off-platform backup destination (and separate retained encryption key); establish access, retention period and available space.
- [ ] Select a current MySQL 8.4-compatible client installed on a controlled operator machine. Do not use a public GitHub runner.
- [ ] Prepare a dedicated read-only Aiven export principal, TLS root CA and a protected client option file. Host/port, account password and CA path must be captured outside Git.
- [ ] Record application schema journal identity, source snapshot instant and any objects that cannot be exported transactionally; account for concurrent DDL and non-InnoDB tables.

No backup is complete merely because an Aiven dashboard shows a timestamp.

## B — Private operator logical export (example; **do not execute without approval**)

On the approved operator machine, use a mode-0600 MySQL options file such as `/private/path/source.cnf`, with verified host, user, password, port, `ssl-mode=VERIFY_IDENTITY` and `ssl-ca`. Check the selected MySQL client supports the options and the Aiven endpoint certificate matches the actual host before connecting. Do not echo or commit the file.

**Mandatory plaintext-staging gate (STOP if unverified):** The sample below writes a *compressed but unencrypted* SQL dump before a later encryption step. A pathname containing `encrypted-workspace` is **not** evidence of encryption. Before executing it, the operator must independently verify that `OUT_DIR` resides on an approved **encrypted-at-rest, unlocked and access-controlled volume**, record that verification privately, and confirm that plaintext staging and filesystem snapshots are excluded from unapproved cloud sync, automatic backup, swap and temporary-file locations. If that cannot be proven, **do not run the example**. Instead obtain security review of a vetted streaming-encryption pipeline that writes only ciphertext to disk (with separately retained keys and authenticated-encryption integrity); do not invent a one-off shell encryption command. The operator must also define post-copy plaintext-staging cleanup and retention controls, understanding that deleting a local file is not proof that its blocks, replicas or snapshots are securely erased.

Keep permissions restricted (`umask 077`, protected client configuration, no shell tracing), do not expose credentials/dump contents in logs, and never store private hashes, dumps, decryption keys or account data in GitHub or public CI. Verify an independently stored encrypted copy and complete an approved **decrypt-plus-isolated-restore** test before checking off recoverability. A checksum or provider-managed backup alone does not meet this requirement.

In a private terminal, after independently verifying the target is **source preview only** **and** the mandatory plaintext-staging gate above:

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
- [ ] Every retained database on `hitech-preview-mysql` (SakthiAI, KirthiVerse, RamaVerse, and `defaultdb` if it contains retained data), plus associated object-storage data, has an **approved encrypted independent export** or documented verified disposition.
- [ ] Both dumps and encrypted files pass integrity checks; immutable hashes recorded.
- [ ] Scratch restore **actually succeeds** and schema/data/journal comparisons pass.
- [ ] Media/object recovery is separately tested or explicitly documented as a blocking gap.
- [ ] Recovery runbook and new database hosting plan approved.
- [ ] A later exact-head application rollout passes `/releasez`, `/healthz`, `/readyz` and authenticated Creator tests before release.
- [ ] Old service shutdown is separately approved only after the new path works.

**Current conclusion (12 November 2026):** documentation and read-only Aiven inventory only. Both project Aiven services are currently reported `POWEROFF`; no independent export or restore has been verified for any of the shared MySQL databases. The data-preservation task is **OPEN/P0**. This runbook change does not power on, export, restore, change a plan, or authorize paid operations.


## Read-only provider checkpoint — 21 November 2026

A fresh **read-only** Aiven inspection was performed without powering on the service, connecting to MySQL, reading SQL, changing credentials, creating a service, upgrading a plan, or incurring provider spend.

Observed provider metadata:
- service `hitech-preview-mysql` remains **POWEROFF**;
- plan remains `free-1-1gb` with reported plan price **USD 0**;
- engine metadata remains MySQL **8.4.8** in `do-blr`;
- the provider still lists `defaultdb`, `kirthiverse_preview`, `ramaverse_preview`, and `sakthiai_preview`;
- three non-incremental managed backup records are currently listed, at approximately **278 MB** each, with backup timestamps on **9 Nov 2026** and **13 Nov 2026** (two snapshots on 13 Nov);
- TLS mode in provider connection metadata remains required.

This supersedes the older statement that hosted backup metadata was only observed through 3 November. It **does not** upgrade the recovery status: provider backup listings are still not an independently exported copy, and no restore/readback has been attempted or proven. The service is powered off, so this checkpoint deliberately did not query table counts, dump content, backup internals, or application data.

**P0 status remains OPEN.** The safe next step still requires separate owner authorization for a controlled source-read/export window (or another provider-supported, independently restorable export path), encrypted off-platform custody, and an isolated scratch restore with schema/data checks. Do not power on or upgrade solely because newer managed backup metadata exists.

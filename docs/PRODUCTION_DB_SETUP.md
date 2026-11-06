# Production database setup (guarded)

`.github/workflows/production-db-setup.yml` is the only path for creating or changing the production schema. It runs the same guard sequence as the preview workflow, but against its own environments, secrets and evidence names. It does not provision anything and does not deploy the application. Provisioning, migration and deployment are separate owner approvals.

## What the owner sets up once (after production provisioning is approved)

| Item | Value |
|---|---|
| Aiven MySQL service | The approved production plan. Database `sakthiai_production`, verified TLS, network limited to the app and the GitHub runners' path |
| Principals | `sakthiai_prod_inspect`: SELECT on `` `sakthiai\_production`.* `` only. `sakthiai_prod_migrator`: SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX on the same; no DROP, GRANT or global privileges. `sakthiai_prod_app`: SELECT, INSERT, UPDATE, DELETE. Never `avnadmin` |
| GitHub environment `sakthiai-production-db-inspect` | Secrets `SAKTHIAI_PRODUCTION_DB_URL` (inspect principal) and `SAKTHIAI_PRODUCTION_DB_CA_B64`; variable `SAKTHIAI_PRODUCTION_DB_ROLE=inspect`; deployment branches restricted to the release branch |
| GitHub environment `sakthiai-production-db-migrate` | Same secret names with the migrator principal; variable `SAKTHIAI_PRODUCTION_DB_ROLE=migrate`; **required reviewer: the owner**; same branch restriction |

Escape the underscore in the grant (`` `sakthiai\_production`.* ``). The guard rejects an unescaped wildcard when `partial_revokes` is OFF.

## Dispatch

```
gh workflow run production-db-setup.yml --ref <release ref> \
  -f mode=inspect \
  -f recovery_point=<newest Aiven backup time, UTC with Z> \
  -f approved_commit=<exact 40-character SHA named in the production approval> \
  -f confirm_database=sakthiai_production
```

The workflow refuses to run unless:

- the environment's role variable matches `mode`;
- `approved_commit` is the exact commit the run checked out;
- `confirm_database` is `sakthiai_production`;
- both secrets exist;
- the host is Aiven, the database name is exact, and the principal is not administrative;
- the recovery point is a real, non-future UTC instant;
- the principal's grants fit the mode exactly;
- the live journal is an exact prefix of the repository journal with matching hashes, no partially applied migration exists, and no row is newer than the recovery point.

`migrate` then applies the pending migrations and checks that nothing was lost. A second apply must be an exact no-op, and the search-text backfill must end at `updated=0`. Evidence is uploaded as `production-migration-evidence-<sha>` and kept for 90 days.

For a brand-new service, `inspect` reports every migration pending (`EMPTY`). Wait for Aiven's first backup and use its time. **Never type a time that is not shown in the Aiven console.**

## Limits

- GitHub dispatches a `workflow_dispatch` workflow only when the file also exists on the default branch. Until this file reaches `main` (through the reviewed merge path), it can be tested only by contract and local MySQL. That is a merge decision, not something to work around.
- Recovery evidence is `OWNER_ATTESTED`, not provider-verified. The restore rehearsal on the provisioned Aiven service remains a separate step: restore PITR into a scratch service, then compare journal and row counts with the `pre` snapshot.

## Tests

- `tests/production-db-setup.test.mjs` covers environments, secret names, isolation from the preview, guard order, migrate-only writers and input handling. It also executes the configuration step against 11 refusal cases.
- `tests/preview-migration-guard.mysql.test.mjs` runs the fresh-production sequence on real MySQL: empty, all pending, migrate, post, rerun no-op.

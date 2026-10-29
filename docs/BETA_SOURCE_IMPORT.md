# Beta synthetic-source import (operator only)

Fresh workspaces have no approved sources, so every chat question ends in `INSUFFICIENT_EVIDENCE` and no model is called. For the private beta, uploads stay OFF (`FILE_INGESTION_BACKEND_ENABLED` unset). The only way sources arrive is this operator-run import of a small, reviewed, **synthetic** corpus into **designated** beta workspaces.

## What it is not
- Not a route, procedure, startup hook or admin page. `server/ops/betaSourceImport.ts` is imported by nothing in `server/`, `client/` or `shared/` (enforced by `server/ops/betaSourceImport.static.test.ts`); only `scripts/import-beta-sources.ts` runs it.
- Not for real or customer data. The corpus is `release/beta-sources/` (6 fictional English/Tamil documents). Every file is hash-pinned in `manifest.json`, must start with `SYNTHETIC TEST DOCUMENT`, must be named `synthetic-*.txt`, and must match its declared language. Anything else is refused.
- Not automatic. It never runs on deploy, migrate or seed. The owner reviews the six files and approves the database write against a named target; both approvals are recorded outside the repository (the tool cannot know them), and the dry-run token is what binds an apply to what was reviewed.

## Guarantees
- **Designated workspaces only.** A workspace qualifies only if it exists AND its owner is on the login allowlist (`AUTH_ALLOWED_SUBJECTS` / `AUTH_ALLOWED_EMAILS` / `OWNER_OPEN_ID`). The login policy must be exactly `allowlist` (open or unset policies are refused; the tool evaluates an unset allowlist as closed). One non-designated or unknown id fails the **whole** plan before any write.
- **Tenant scoped.** Every document and chunk row carries the target `workspaceId`. Nothing is written to any other workspace.
- **Idempotent.** Keyed on `(workspaceId, contentHash)`, the same key normal uploads de-duplicate on. Each document plus its chunks commit in one transaction under a per-workspace row lock held until commit; concurrent runs cannot create duplicates (tested with two simultaneous runs).
- **Bound to intent.** Apply needs `--confirm <token>` (derived from the corpus bytes, the workspace ids and the database name) and `--expect-database <name>` equal to the connected database.
- **No side channels.** No network, no embeddings, no object storage (`storageKey` stays NULL; chat does not read storage). Output contains workspace ids, names and counts: no emails, subjects, connection strings or secrets.

## Run
```
# env: DATABASE_URL, DATABASE_EXPECTED_NAME, and the SAME allowlist variables as the target deployment
pnpm ops:import-beta-sources --list-workspaces                                   # read-only
pnpm ops:import-beta-sources --workspace-id 12 --workspace-id 13                 # dry run: plan + confirmation token, writes nothing
pnpm ops:import-beta-sources --workspace-id 12 --workspace-id 13 --apply --confirm IMPORT-XXXXXXXXXXXXXXXX --expect-database <database name>
```
Exit codes: 0 ok, 2 refused (nothing written), 1 failure. A workspace exists only after its user has signed in once.

## Verify
`--apply` re-reads each workspace and reports `verification[].ok`. Then sign in as that user: the six `synthetic-*.txt` files are listed under Files, and an English question about the library or a Tamil question about the learning centre returns a cited answer.

## Remove
Not provided as a tool. Removal is a database write needing its own approval: delete `documentChunks` then `documents` rows for the listed `synthetic-*` filenames in the designated workspaces.

## Evidence
`server/ops/betaSourceImport.test.ts` (corpus and token), `.static.test.ts` (no public surface), `.mysql.test.ts` (tenant rejection with zero writes, token and database binding, idempotency, repair, concurrency, retrieval scoped to the workspace) and `e2e/specs/beta-posture.spec.ts` (the real CLI against a real server and browser).

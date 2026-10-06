# Resume / verify (PR #29 integration delta)
Requires prerequisite commit bf2835bba3d65ee255501cbf8bcf4e045456a3af (already on origin).
    sha256sum -c SHA256SUMS
    git bundle verify sakthiai-integration-delta.bundle
    git fetch sakthiai-integration-delta.bundle   # tip: 77de9f73048ffbab1d48b450db522500a7e98095
    git merge-base --is-ancestor bf2835bba3d65ee255501cbf8bcf4e045456a3af 77de9f73048ffbab1d48b450db522500a7e98095
Remote already contains 77de9f73048ffbab1d48b450db522500a7e98095; this bundle is a recovery copy only — never force-push.
Redeploy preview (autoDeploy OFF): Render → sakthiai-hitech-preview → Manual Deploy → latest commit; confirm /releasez == 77de9f73048ffbab1d48b450db522500a7e98095.
Rollback: Render → Deploys → dep-db1fjrpsrm7s73bf8lf0 (a9be03b), dep-db1e6jpsrm7s73b9bdm0 (7b240f7) or dep-dav0miaj7g8c73aakpg0 (79fbe21, pre-session) → Rollback.
Preview DB migration (four-day plan, Day 1): owner first adds repo secrets SAKTHIAI_PREVIEW_DATABASE_URL and AIVEN_MYSQL_CA_CERT_B64.
Then Actions → "SakthiAI Preview DB Setup" (ref: integration branch) with mode=inspect, recovery_point=2026-10-05T12:28:44.420027Z
(the provider-listed backup; use a newer backup timestamp if the DB was written since; never the old 2026-10-02 backup).
Only if every inspect step passes: the same dispatch once with mode=migrate. Recorded as OWNER_ATTESTED, never provider-verified; a listed backup is not a tested restore.
Guard refuses a wrong DB name, Drizzle hash/order mismatch, rows newer than the recovery point, row/column/table loss, and any change during the rerun.
Read-only before/after check (from 77de9f7): /readyz databaseSchema.status is "behind" before and "current" after.
Active schedule: SAKTHIAI_20_DAY_CONTINUATION_PLAN.md → "Active schedule: four dependency-driven days".

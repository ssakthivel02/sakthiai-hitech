# Resume / verify (PR #29 integration delta)
Requires prerequisite commit bf2835bba3d65ee255501cbf8bcf4e045456a3af (already on origin).
    sha256sum -c SHA256SUMS
    git bundle verify sakthiai-integration-delta.bundle
    git fetch sakthiai-integration-delta.bundle   # tip: ca6c3693825300451d2c1510be8c96357d67054d
    git merge-base --is-ancestor bf2835bba3d65ee255501cbf8bcf4e045456a3af ca6c3693825300451d2c1510be8c96357d67054d
Remote already contains ca6c3693825300451d2c1510be8c96357d67054d; this bundle is a recovery copy only — never force-push.
Redeploy preview (autoDeploy OFF): Render → sakthiai-hitech-preview → Manual Deploy → latest commit; confirm /releasez == ca6c3693825300451d2c1510be8c96357d67054d.
Rollback: Render → Deploys → dep-db1ecfnavr4c73bh0qg0 (2ea4b4f), dep-db1e6jpsrm7s73b9bdm0 (7b240f7) or dep-dav0miaj7g8c73aakpg0 (79fbe21) → Rollback.
Preview DB migration: Actions → "SakthiAI Preview DB Setup" (ref: integration branch) with recovery_point=<Aiven backup UTC with Z, e.g. 2026-10-02T07:58:07Z>; recorded as OWNER_ATTESTED, never provider-verified. Guard refuses wrong DB name, Drizzle hash/order mismatch, rows newer than the recovery point, row/column/table loss, and any change during the rerun.

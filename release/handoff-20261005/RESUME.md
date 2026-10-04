# Resume / verify (PR #29 integration delta)
Requires prerequisite commit bf2835bba3d65ee255501cbf8bcf4e045456a3af (already on origin).
    sha256sum -c SHA256SUMS
    git bundle verify sakthiai-integration-delta.bundle
    git fetch sakthiai-integration-delta.bundle   # tip: 2ea4b4f6909dfc11f3084d8294e016531b96b1c5
    git merge-base --is-ancestor bf2835bba3d65ee255501cbf8bcf4e045456a3af 2ea4b4f6909dfc11f3084d8294e016531b96b1c5
Remote already contains 2ea4b4f6909dfc11f3084d8294e016531b96b1c5; this bundle is a recovery copy only — never force-push.
Redeploy preview (autoDeploy OFF): Render → sakthiai-hitech-preview → Manual Deploy → latest commit; confirm /releasez == 2ea4b4f6909dfc11f3084d8294e016531b96b1c5.
Rollback: Render → Deploys → dep-db1e6jpsrm7s73b9bdm0 (7b240f7) or dep-dav0miaj7g8c73aakpg0 (79fbe21) → Rollback.
Preview DB migration: Actions → "SakthiAI Preview DB Setup" (ref: integration branch) with recovery_point=<Aiven backup UTC>.

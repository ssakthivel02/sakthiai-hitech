# GOV-SAFE-001 Operator Notes

If another task changes `main` while this PR is open, do not merge this branch as-is. Reconcile current main into the governance lane, review all high-risk overlap deliberately, then require a new exact-head CI set.

If Creator PR #7 or another runtime branch overlaps governance files, preserve current-main runtime/security behavior first; governance reconciliation must not roll back tenant isolation or other newer controls.

Do not close the historical PR #2 until the clean current-main governance reconciliation is either merged or intentionally abandoned. Once this reconciliation is merged, PR #2 should be closed as superseded/read-only donor rather than merged.

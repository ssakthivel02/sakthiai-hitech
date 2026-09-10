# GOV-SAFE-001 Rollback Policy

Do not roll back governance by rewriting `main` history.

If a governance defect is discovered after merge:
1. capture the exact affected main SHA;
2. open a dedicated fix branch from current main;
3. preserve unrelated newer work;
4. correct only the defective governance behavior;
5. run exact-head QA;
6. merge through normal protected PR flow with expected-head guard;
7. verify main/protection again.

Never disable required checks or branch protection as a rollback shortcut.

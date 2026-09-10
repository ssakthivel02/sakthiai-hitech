# GOV-SAFE-001 Manual Blocker

Manual GitHub administration is required because the connected GitHub integration does not expose ruleset/branch-protection write administration.

Required manual action: configure the active `main` ruleset described in `GOV_SAFE_001_RULESET_SETUP.md` after repository-side CI is green/merged as appropriate, then allow a fresh API read to verify the resulting state.

No repository code change can substitute for this server-side action.

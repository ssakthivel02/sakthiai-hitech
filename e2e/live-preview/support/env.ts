// Required configuration for the live-preview browser check. Every value is read from the environment
// (GitHub Environment secrets when dispatched, or a local shell when run by hand) — never hardcoded, never
// logged, never written to a report. Two DISTINCT dedicated test accounts are required so workspace
// isolation can be proven as a real cross-account negative case, not asserted against a single identity.
//
// This suite drives the real "Sign in securely" button and the real external OIDC provider's own login
// page end to end. It never calls a stub OIDC endpoint and never bypasses authentication.

export interface LivePreviewAccount {
  email: string;
  password: string;
}

export interface LivePreviewEnv {
  previewUrl: string;
  expectedCommit: string;
  accountA: LivePreviewAccount;
  accountB: LivePreviewAccount;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is required to run the live-preview browser check. This check only runs against a real, ` +
        "already-deployed preview with two real, dedicated, allow-listed test accounts (OWNER_OPEN_ID or " +
        "AUTH_ALLOWED_EMAILS/AUTH_ALLOWED_SUBJECTS on that deployment) — it never falls back to a stub login.",
    );
  }
  return value.trim();
};

// The live browser smoke is now intentionally read-only with respect to user content.
// It requires existing workspaces and a pre-seeded grounded artifact; it never calls
// chat.send, embeddings, or the model gateway. The historical workflow consent input
// is retained as a compatible no-op while the workflow is registered on main.
//
// A future test that creates retained chat data must add explicit owner consent
// and its own retention/cleanup disclosure before any provider call or write.

export const loadLivePreviewEnv = (): LivePreviewEnv => ({
  previewUrl: required("PREVIEW_URL"),
  expectedCommit: required("EXPECTED_COMMIT"),
  accountA: { email: required("PREVIEW_TEST_ACCOUNT_A_EMAIL"), password: required("PREVIEW_TEST_ACCOUNT_A_PASSWORD") },
  accountB: { email: required("PREVIEW_TEST_ACCOUNT_B_EMAIL"), password: required("PREVIEW_TEST_ACCOUNT_B_PASSWORD") },
});

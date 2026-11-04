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

// This suite creates one real chat conversation (and its user + assistant messages) per run, via
// chat.send, to produce an artifact to test cross-tenant isolation on. server/routers.ts's chat router
// exposes only history/send/sendAsync — there is no delete or archive procedure for a conversation or
// message anywhere in the app (artifacts.delete removes only the artifact row, never its source chat).
// So that conversation is permanently retained on the live preview after every run; there is no supported
// API this suite could call to remove it. Rather than retain that data silently, loading this env requires
// the owner to have explicitly accepted the retention for this run (PREVIEW_TEST_ACKNOWLEDGE_CHAT_RETENTION
// must be exactly "true") — the exact retained conversation/message identifiers are then still logged and
// attached to the test report every run (see auth-isolation-artifacts.spec.ts), so what was retained is
// always traceable even though it was accepted in advance, not approved after the fact.
const requiredAcknowledgement = (name: string, explanation: string): void => {
  if (process.env[name] !== "true") {
    throw new Error(`${name} must be set to exactly "true" to run the live-preview browser check: ${explanation}`);
  }
};

export const loadLivePreviewEnv = (): LivePreviewEnv => {
  requiredAcknowledgement(
    "PREVIEW_TEST_ACKNOWLEDGE_CHAT_RETENTION",
    "this suite permanently retains one chat conversation and its messages on the live preview after " +
      "every run — no supported cleanup API exists for conversations or messages. The owner must " +
      "explicitly accept this retention before each dispatch.",
  );
  return {
    previewUrl: required("PREVIEW_URL"),
    expectedCommit: required("EXPECTED_COMMIT"),
    accountA: { email: required("PREVIEW_TEST_ACCOUNT_A_EMAIL"), password: required("PREVIEW_TEST_ACCOUNT_A_PASSWORD") },
    accountB: { email: required("PREVIEW_TEST_ACCOUNT_B_EMAIL"), password: required("PREVIEW_TEST_ACCOUNT_B_PASSWORD") },
  };
};

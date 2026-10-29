/** Loopback-only ports for the E2E stack. "localhost" (not 127.0.0.1) is the app origin: browsers accept Secure/__Host- cookies there over http. */
export const PORTS = { app: 4310, oidc: 4311, local: 4312, external: 4313, s3: 4314, clamd: 4315, beta: 4320 } as const;
export const APP_ORIGIN = `http://localhost:${PORTS.app}`;
export const urls = {
  oidcAuthorize: `http://localhost:${PORTS.oidc}/authorize`,
  oidc: `http://127.0.0.1:${PORTS.oidc}`,
  local: `http://127.0.0.1:${PORTS.local}`,
  external: `http://127.0.0.1:${PORTS.external}`,
  s3: `http://127.0.0.1:${PORTS.s3}`,
};

/** Second server in the BETA POSTURE: uploads OFF, no object storage, login allowlist, own database. Same fake OIDC / fake LLM. */
export const BETA_ORIGIN = `http://localhost:${PORTS.beta}`;
/** Fixed identities: the beta server's allowlist is read at start-up, so these cannot be minted per test. */
export const BETA_IDENTITIES = {
  alice: { sub: "beta-alice", name: "Beta Alice", email: "alice@example.test" },
  bob: { sub: "beta-bob", name: "Beta Bob", email: "bob@example.test" },
  carol: { sub: "beta-carol", name: "Beta Carol", email: "carol@example.test" },
  mallory: { sub: "beta-mallory", name: "Mallory Denied", email: "mallory@example.test" },
} as const;
export const BETA_ALLOWED_SUBJECTS = [BETA_IDENTITIES.alice.sub, BETA_IDENTITIES.bob.sub, BETA_IDENTITIES.carol.sub].join(",");

/** Loopback-only ports for the E2E stack. "localhost" (not 127.0.0.1) is the app origin: browsers accept Secure/__Host- cookies there over http. */
export const PORTS = { app: 4310, oidc: 4311, local: 4312, external: 4313, s3: 4314, clamd: 4315 } as const;
export const APP_ORIGIN = `http://localhost:${PORTS.app}`;
export const urls = {
  oidcAuthorize: `http://localhost:${PORTS.oidc}/authorize`,
  oidc: `http://127.0.0.1:${PORTS.oidc}`,
  local: `http://127.0.0.1:${PORTS.local}`,
  external: `http://127.0.0.1:${PORTS.external}`,
  s3: `http://127.0.0.1:${PORTS.s3}`,
};

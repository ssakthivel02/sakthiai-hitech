import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../server/testing/mysqlTestDb";
import { startFakeClamd, startFakeLlm, startFakeOidc, startFakeS3, type Closeable } from "./support/fakes";
import { APP_ORIGIN, PORTS, urls } from "./support/ports";

/**
 * Brings up the whole stack with zero external dependencies: a throwaway MySQL-compatible database (TEST_DATABASE_URL,
 * migrated by the same harness as the integration suite), fake OIDC / local LLM / "external" LLM / S3 / clamd, and the REAL
 * built server (dist/index.js). No paid API, no managed database, no deployed service is ever contacted.
 */
export default async function globalSetup() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("E2E_FAIL: TEST_DATABASE_URL is required (a local/CI MySQL-compatible server; a throwaway database is created and dropped)");
  if (!existsSync(path.resolve("dist/index.js"))) throw new Error("E2E_FAIL: dist/index.js missing — run via `pnpm test:e2e` (builds with the fake OIDC authorize URL baked in)");
  mkdirSync("reports/e2e", { recursive: true });

  const database: TestDatabase = await createTestDatabase();
  const fakes: Closeable[] = [];
  fakes.push(await startFakeOidc(PORTS.oidc), await startFakeLlm(PORTS.local, "local"), await startFakeLlm(PORTS.external, "external"), await startFakeS3(PORTS.s3), await startFakeClamd(PORTS.clamd));

  const log = createWriteStream("reports/e2e/server.log");
  const child: ChildProcess = spawn("node", ["dist/index.js"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      // NODE_ENV is deliberately NOT "production": the production build rejects a non-https OIDC callback (correct behaviour), and this stack is plain-http loopback.
      NODE_ENV: "test", PORT: String(PORTS.app),
      DATABASE_URL: database.url, DATABASE_EXPECTED_NAME: database.name,
      JWT_SECRET: "e2e-only-secret-not-a-credential-0123456789abcdef", VITE_APP_ID: "sakthiai-e2e",
      OIDC_AUTHORIZATION_URL: urls.oidcAuthorize, OIDC_TOKEN_URL: `${urls.oidc}/token`, OIDC_USERINFO_URL: `${urls.oidc}/userinfo`, OIDC_CLIENT_ID: "sakthiai-e2e", OIDC_PROVIDER_NAME: "fake-oidc",
      LOCAL_LLM_API_URL: `${urls.local}/v1`, LOCAL_LLM_MODEL: "fake-local-model",
      // An external provider IS configured so that "blocked by default" is a real assertion; GATEWAY_ALLOW_EXTERNAL is intentionally unset.
      LLM_API_URL: `${urls.external}/v1`, LLM_MODEL: "fake-external-model", LLM_API_KEY: "e2e-not-a-real-key",
      GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_TIMEOUT_MS: "5000", GATEWAY_BACKOFF_BASE_MS: "10",
      STORAGE_ENDPOINT: urls.s3, STORAGE_BUCKET: "e2e", STORAGE_REGION: "us-east-1", STORAGE_FORCE_PATH_STYLE: "true", STORAGE_ACCESS_KEY_ID: "e2e", STORAGE_SECRET_ACCESS_KEY: "e2e",
      MALWARE_SCANNER_HOST: "127.0.0.1", MALWARE_SCANNER_PORT: String(PORTS.clamd), MALWARE_SCANNER_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log); child.stderr?.pipe(log);

  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${APP_ORIGIN}/readyz`)).status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`E2E_FAIL: server exited early (${child.exitCode}); see reports/e2e/server.log`);
    if (Date.now() > deadline) throw new Error("E2E_FAIL: server never became ready; see reports/e2e/server.log");
    await new Promise(r => setTimeout(r, 300));
  }

  return async () => {
    child.kill("SIGTERM");
    await new Promise(r => { child.once("exit", r); setTimeout(r, 5000); });
    log.end();
    for (const fake of fakes) await fake.close();
    await database.close();
  };
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { urls } from "./ports";

/**
 * A disposable opt-in process for the existing Creator browser acceptance.
 * Shares ONLY the global-setup-created throwaway MySQL database and loopback
 * fakes. Never starts a preview, deploys, publishes, or contacts paid engines.
 *
 * The primary E2E server intentionally keeps fenced rendering OFF. This
 * isolated process enables the existing fenced dispatcher for one test only.
 */
export async function startDisposableFencedCreatorServer() {
  const databaseUrl = process.env.E2E_CREATOR_DATABASE_URL;
  if (!databaseUrl) throw new Error("E2E_FENCED_DISPOSABLE_DB_REQUIRED");
  const parsed = new URL(databaseUrl);
  const name = parsed.pathname.slice(1);
  if (parsed.protocol !== "mysql:" ||
      !["localhost", "127.0.0.1", "mysql", "db"].includes(parsed.hostname) ||
      !/^sakthi_it_[a-z0-9]+_[a-f0-9]{8}$/.test(name)) {
    throw new Error("E2E_FENCED_UNSAFE_DATABASE_TARGET");
  }
  for (const executable of ["ffmpeg", "ffprobe"]) {
    const probe = spawnSync(executable, ["-version"], { timeout: 5000, stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      throw new Error("E2E_FENCED_MEDIA_TOOL_MISSING:" + executable);
    }
  }
  const port = 4330;
  const origin = "http://localhost:" + port;
  const child: ChildProcess = spawn("node", ["dist/index.js"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      NODE_ENV: "test", PORT: String(port),
      DATABASE_URL: databaseUrl, DATABASE_EXPECTED_NAME: name,
      JWT_SECRET: "e2e-only-secret-not-a-credential-0123456789abcdef",
      VITE_APP_ID: "sakthiai-e2e",
      OIDC_AUTHORIZATION_URL: urls.oidcAuthorize,
      OIDC_TOKEN_URL: urls.oidc + "/token",
      OIDC_USERINFO_URL: urls.oidc + "/userinfo",
      OIDC_CLIENT_ID: "sakthiai-e2e", OIDC_PROVIDER_NAME: "fake-oidc",
      LOCAL_LLM_API_URL: urls.local + "/v1", LOCAL_LLM_MODEL: "fake-local-model",
      STORAGE_ENDPOINT: urls.s3, STORAGE_BUCKET: "e2e",
      STORAGE_REGION: "us-east-1", STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_ACCESS_KEY_ID: "e2e", STORAGE_SECRET_ACCESS_KEY: "e2e",
      MALWARE_SCANNER_HOST: "127.0.0.1", MALWARE_SCANNER_PORT: "4315",
      MALWARE_SCANNER_TIMEOUT_MS: "3000",
      FILE_INGESTION_BACKEND_ENABLED: "true",
      CREATOR_FENCED_RENDER_ENABLED: "true",
      CREATOR_FENCED_DERIVATIVE_ENABLED: "false",
      CREATOR_ASYNC_RENDER_WORKER_ENABLED: "false",
      CREATOR_FFMPEG_TIMEOUT_MS: "120000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  let spawnError: Error | undefined;
  const collect = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-6000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error: Error) => { spawnError = error; });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exit, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) {
        throw new Error("E2E_FENCED_SERVER_EXITED:" + String(spawnError ?? child.exitCode) + ":" + tail);
      }
      try {
        if ((await fetch(origin + "/readyz")).status === 200) return { origin, close };
      } catch { /* Wait for the disposable process only. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("E2E_FENCED_SERVER_NOT_READY:" + tail);
  } catch (error) {
    await close();
    throw error;
  }
}

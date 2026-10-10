#!/usr/bin/env node
// Starts the BUILT server (dist/index.js) and checks liveness, the SPA shell and the fail-closed readiness contract.
// Writes reports/release/smoke.json. No network beyond 127.0.0.1; no database is configured, so /readyz MUST be 503.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = process.env.SMOKE_PORT ?? "3211"; const OUT = process.env.SMOKE_REPORT_PATH ?? "reports/release/smoke.json";
const base = `http://127.0.0.1:${PORT}`; const result = { schema: "sakthiai.built-server-smoke/v1", distPresent: existsSync("dist/index.js"), port: Number(PORT), ok: false, healthz: null, rootBytes: 0, readyz: null, detail: "" };
const finish = code => { mkdirSync("reports/release", { recursive: true }); writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`); console.log(`SMOKE_${result.ok ? "PASS" : "FAIL"} healthz=${result.healthz} rootBytes=${result.rootBytes} readyz=${result.readyz} ${result.detail}`); process.exit(code); };
if (!result.distPresent) { result.detail = "dist/index.js missing; run pnpm build"; finish(1); }
const env = { ...process.env, PORT, NODE_ENV: "production" };
for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "LLM_API_URL", "LOCAL_LLM_API_URL", "MALWARE_SCANNER_HOST"]) delete env[key];
const server = spawn("node", ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] }); let log = "";
server.stdout.on("data", d => { log += d; }); server.stderr.on("data", d => { log += d; });
const stop = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
process.on("exit", stop);
const get = async path => { const r = await fetch(`${base}${path}`); return { status: r.status, body: await r.text() }; };
try {
  let health = null;
  for (let i = 0; i < 30 && !health; i += 1) { try { const r = await get("/healthz"); if (r.status === 200) health = r; } catch { /* not up yet */ } if (!health) await new Promise(r => setTimeout(r, 1000)); }
  if (!health) { result.detail = `server did not become healthy: ${log.slice(-300)}`; finish(1); }
  result.healthz = 200;
  const root = await get("/"); result.rootBytes = Buffer.byteLength(root.body); if (root.status !== 200 || !result.rootBytes) { result.detail = `GET / returned ${root.status}`; finish(1); }
  const ready = await get("/readyz"); result.readyz = ready.status;
  if (ready.status !== 503) { result.detail = `expected /readyz 503 (fail closed without required services), got ${ready.status}`; finish(1); }
  result.ok = true; finish(0);
} catch (error) { result.detail = String(error).slice(0, 200); finish(1); }

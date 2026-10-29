// Application maintenance mode, exercised on the BUILT server entry point (no database, provider or network).
// Proves the containment path documented in docs/PREVIEW_ROLLBACK_RUNBOOK.md for builds that contain it.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const workDir = path.join(root, "node_modules", ".cache", `maintenance-mode-${process.pid}`);
const children = [];

beforeAll(() => {
  execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", `--outdir=${path.join(workDir, "dist")}`, "--log-level=error"], { cwd: root });
  fs.mkdirSync(path.join(workDir, "dist", "public"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "dist", "public", "index.html"), "<!doctype html><title>app</title>");
}, 60_000);
afterAll(() => { for (const c of children) try { c.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(workDir, { recursive: true, force: true }); });

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function start(mode) {
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(port), NODE_PATH: path.join(root, "node_modules") };
  if (mode !== undefined) env.SAKTHIAI_MAINTENANCE_MODE = mode;
  const child = spawn("node", ["dist/index.js"], { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = ""; child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).status === 200) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
  return { child, base, log: () => log };
}

beforeAll(() => { try { fs.symlinkSync(path.join(root, "node_modules"), path.join(workDir, "node_modules"), "dir"); } catch { /* exists */ } });

describe("maintenance mode on the built server", () => {
  it("refuses every application route before parsing or auth, keeps health and identity, reports not ready, and exits cleanly", async () => {
    const { child, base, log } = await start("true");
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "alive", maintenanceMode: true });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    const readyBody = await ready.json();
    expect(readyBody).toEqual({ status: "maintenance", service: "sakthiai", maintenanceMode: true }); // no dependency probed
    expect(await (await fetch(`${base}/releasez`)).json()).toMatchObject({ maintenanceMode: true });

    for (const [method, p, body] of [["GET", "/api/trpc/auth.me", undefined], ["POST", "/api/trpc/chat.send", "x".repeat(200_000)], ["GET", "/api/oauth/callback?code=a&state=b", undefined], ["GET", "/api/storage/anything", undefined]]) {
      const r = await fetch(`${base}${p}`, { method, body, headers: body ? { "content-type": "application/json" } : {} });
      expect(r.status, p).toBe(503);
      expect(r.headers.get("retry-after"), p).toBe("300");
      expect(await r.json(), p).toMatchObject({ error: { reason: "MAINTENANCE" } });
    }
    const page = await fetch(`${base}/projects/1`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("maintenance");
    expect(log()).toMatch(/MAINTENANCE MODE/);
    expect(log()).not.toMatch(/task runtime|upload cleanup/i);

    const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);

  it("an unrecognised value fails closed: maintenance on, with a warning", async () => {
    const { base, log } = await start("yes");
    expect((await fetch(`${base}/api/trpc/auth.me`)).status).toBe(503);
    expect(log()).toMatch(/fail closed/);
  }, 30_000);

  it("unset: application routes are served normally (no maintenance refusal)", async () => {
    const { base } = await start(undefined);
    const r = await fetch(`${base}/api/trpc/auth.me`);
    expect(r.headers.get("retry-after")).toBeNull();
    expect(JSON.stringify(await r.json())).not.toContain("MAINTENANCE");
    const page = await fetch(`${base}/projects/1`);
    expect(page.status).toBe(200);
    expect(await (await fetch(`${base}/releasez`)).json()).toMatchObject({ maintenanceMode: false });
  }, 30_000);
});

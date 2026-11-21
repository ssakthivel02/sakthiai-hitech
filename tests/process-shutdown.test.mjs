// P-G9: process-level shutdown reliability of the BUILT server entry point.
//
// Render signals the process it launched. Under `pnpm start` that is the pnpm wrapper, which dies on SIGTERM
// ("ELIFECYCLE Command failed.") and never forwards the signal, so the app's graceful handler (task runtime and
// upload-cleanup stop, HTTP drain) does not run. These tests pin (a) the deployment contract that removes the wrapper
// and (b) the real behaviour of the bundled entry point when it IS the signalled process.
// No database, network provider, credential or external service is used: the server runs with no DATABASE_URL.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe("P-G9 deployment contract: the signalled process is node, not a package-manager wrapper", () => {
  const render = read("render.yaml");
  const pkg = JSON.parse(read("package.json"));

  it("render.yaml execs the built entry point (node becomes the signalled process)", () => {
    expect(render).toMatch(/^\s*startCommand:\s*exec node dist\/index\.js\s*$/m);
    expect(render).not.toMatch(/startCommand:.*\b(pnpm|npm|yarn|npx)\b/);
  });

  it("direct start still runs in production mode (NODE_ENV comes from render.yaml, not from pnpm)", () => {
    expect(render).toMatch(/- key: NODE_ENV\n\s+value: production/);
  });

  it("the start command's entry point is exactly what the build emits", () => {
    expect(pkg.scripts.build).toMatch(/esbuild server\/_core\/index\.ts .*--format=esm --outdir=dist\b/);
    expect(pkg.scripts.start).toBe("NODE_ENV=production node dist/index.js");
  });
});

// <workdir>/dist/index.js mirrors the deployed layout so render.yaml's startCommand runs verbatim; no .env exists here.
const workDir = path.join(root, "node_modules", ".cache", `process-shutdown-${process.pid}`);
const bundleDir = path.join(workDir, "dist");
const cwd = workDir;
const renderStartCommand = read("render.yaml").match(/^\s*startCommand:\s*(.+?)\s*$/m)?.[1];

beforeAll(() => {
  // Same bundling flags as `pnpm build` for the server half; externals resolve from the repo's node_modules.
  execFileSync(path.join(root, "node_modules/.bin/esbuild"), ["server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", `--outdir=${bundleDir}`, "--log-level=error"], { cwd: root });
}, 60_000);

afterAll(() => {
  // A failing run can orphan node (that is the defect under test): reap anything still using the work directory as cwd.
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try { if (fs.readlinkSync(`/proc/${entry}/cwd`) === workDir) process.kill(Number(entry), "SIGKILL"); } catch { /* gone or not ours */ }
    }
  } catch { /* no /proc on this platform */ }
  fs.rmSync(workDir, { recursive: true, force: true });
});

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const portOpen = port => new Promise(resolve => {
  const socket = net.connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts the bundled server. Default: node is the signalled process. launch="render": render.yaml's startCommand through /bin/sh -c. */
async function startServer(extraEnv = {}, launch = "node") {
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), NODE_ENV: "production", PORT: String(port), ...extraEnv };
  const child = launch === "render"
    ? spawn("/bin/sh", ["-c", renderStartCommand], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [path.join(bundleDir, "index.js")], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const started = Date.now();
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - started })));
  for (let i = 0; i < 100 && !output.includes("Server running on"); i += 1) await sleep(100);
  if (!output.includes("Server running on")) { child.kill("SIGKILL"); throw new Error(`server did not start: ${output}`); }
  return { child, port, exited, output: () => output };
}

const healthz = port => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: "/healthz" }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); }).on("error", reject);
});

describe("P-G9 render.yaml startCommand through the system shell (what Render signals)", () => {
  it("SIGTERM to the launched process reaches node: graceful handler runs, exit 0, port closed, nothing orphaned", async () => {
    const s = await startServer({}, "render");
    expect(await healthz(s.port)).toBe(200);
    s.child.kill("SIGTERM"); // the launched process is the one the platform signals
    const result = await s.exited;
    await sleep(500);
    const stillListening = await portOpen(s.port);
    expect(s.output()).toContain("SIGTERM received: stopping task runtime, then HTTP server");
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(stillListening).toBe(false);
  }, 20_000);
});

describe("P-G9 built entry point, signalled directly", () => {
  it("SIGTERM: runs the graceful handler, exits 0 promptly, closes the port, leaves no process", async () => {
    const s = await startServer();
    expect(await healthz(s.port)).toBe(200);
    const sentAt = Date.now();
    s.child.kill("SIGTERM");
    const result = await s.exited;
    expect(s.output()).toContain("SIGTERM received: stopping task runtime, then HTTP server");
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(Date.now() - sentAt).toBeLessThan(8_000);
    expect(await portOpen(s.port)).toBe(false);
    expect(alive(s.child.pid)).toBe(false);
  }, 20_000);

  it("SIGINT behaves the same", async () => {
    const s = await startServer();
    s.child.kill("SIGINT");
    expect(await s.exited).toMatchObject({ code: 0, signal: null });
    expect(s.output()).toContain("SIGINT received");
  }, 20_000);

  it("repeated signals are idempotent: one shutdown, exit 0", async () => {
    const s = await startServer();
    s.child.kill("SIGTERM");
    s.child.kill("SIGTERM");
    s.child.kill("SIGINT");
    expect(await s.exited).toMatchObject({ code: 0, signal: null });
    expect(s.output().match(/received: stopping task runtime/g)).toHaveLength(1);
  }, 20_000);

  it("task worker and upload cleanup enabled (no database): starts, then stops gracefully and in bounded time", async () => {
    const s = await startServer({ TASK_WORKER_ENABLED: "true", UPLOAD_CLEANUP_ENABLED: "true", TASK_WORKER_SHUTDOWN_GRACE_MS: "1000" });
    expect(await healthz(s.port)).toBe(200);
    await sleep(500);
    s.child.kill("SIGTERM");
    const result = await s.exited;
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.ms).toBeLessThan(15_000);
    expect(s.output()).not.toMatch(/unhandled|UnhandledPromiseRejection/i);
  }, 30_000);

  it("an in-flight request is allowed to finish; new connections are refused during shutdown; then exit 0", async () => {
    const s = await startServer();
    // Request whose body is still arriving when the signal lands (the server is mid-request, not idle).
    const response = new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/trpc/system.health", headers: { "content-type": "application/json", "content-length": "20" } }, res => {
        res.resume(); res.once("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write("{");
      s.pending = req;
    });
    await sleep(300);
    s.child.kill("SIGTERM");
    // Listener closes first: a brand-new connection must be refused, while the in-flight one is still being served.
    let refused = false;
    for (let i = 0; i < 40 && !refused; i += 1) { refused = !(await portOpen(s.port)); if (!refused) await sleep(50); }
    expect(refused).toBe(true);
    expect(alive(s.child.pid)).toBe(true); // still draining the open request
    s.pending.end('"x":"yyyyyyyy"}'.padEnd(19, " ")); // completes the 20-byte body
    const status = await response;
    expect(status).toBeGreaterThanOrEqual(200);
    expect(await s.exited).toMatchObject({ code: 0, signal: null });
  }, 30_000);

  it("a request that never completes cannot hold the process hostage: forced exit within the bounded grace", async () => {
    const s = await startServer({ TASK_WORKER_SHUTDOWN_GRACE_MS: "0" }); // force timer = grace + 10 s
    const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/trpc/system.health", headers: { "content-type": "application/json", "content-length": "1000" } });
    req.on("error", () => undefined);
    req.write("{");
    await sleep(300);
    s.child.kill("SIGTERM");
    const result = await s.exited;
    expect(result.code).toBe(1);
    expect(result.ms).toBeGreaterThan(8_000);
    expect(result.ms).toBeLessThan(14_000);
    expect(alive(s.child.pid)).toBe(false);
    req.destroy();
  }, 40_000);
});

#!/usr/bin/env node
// Built-artifact identity for SakthiAI.
//   --write  (run by `pnpm build`): hash every file under dist/ and write dist/release-manifest.json
//   --verify: recompute and compare with the manifest (exit 1 on any difference)
//
// artifactDigest = sha256 over the sorted lines "<sha256> <relative/posix/path>\n" of every dist file except the manifest.
// It covers only built bytes, so the same source, lockfile and toolchain give the same digest wherever the build runs:
// a host that rebuilds from source can be tied to the CI-retained artifact by comparing digests (the running server
// reports its own, recomputed at startup, on /releasez).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_NAME = "release-manifest.json";
const sha256 = data => createHash("sha256").update(data).digest("hex");

export function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const digestOf = lines => sha256(lines.join(""));
/**
 * Whole-artifact digest plus two components: "client" (dist/public/**, the browser bundle, which embeds the build-time
 * VITE_* values) and "server" (everything else, chiefly dist/index.js, which reads its configuration at runtime).
 */
export function computeArtifactDigest(distDir) {
  const files = listFiles(distDir).filter(f => f !== MANIFEST_NAME).sort();
  const lines = files.map(f => `${sha256(readFileSync(path.join(distDir, f)))} ${f}\n`);
  const client = lines.filter((_, i) => files[i].startsWith("public/"));
  const server = lines.filter((_, i) => !files[i].startsWith("public/"));
  return {
    digest: digestOf(lines), fileCount: files.length,
    components: { server: { digest: digestOf(server), fileCount: server.length }, client: { digest: digestOf(client), fileCount: client.length } },
  };
}

/**
 * The browser bundle depends on build-time VITE_* values, so equal source does not give an equal client digest unless
 * these are equal too. Values are public (they ship to every browser) but are still only fingerprinted, never written.
 */
export function buildEnvironmentFingerprint(env = process.env) {
  const names = Object.keys(env).filter(k => k.startsWith("VITE_") && env[k] !== undefined && env[k] !== "").sort();
  return { viteVariables: names, fingerprint: sha256(names.map(k => `${k}=${env[k]}\n`).join("")) };
}

// The host's own record of what it checked out wins, then the checked-out HEAD, then the CI event SHA.
function sourceCommit(root) {
  const render = process.env.RENDER_GIT_COMMIT?.trim();
  if (render) return render;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
  } catch { /* not a git checkout */ }
  return process.env.GITHUB_SHA?.trim() || "unknown";
}

function pnpmVersion() {
  const agent = process.env.npm_config_user_agent ?? "";
  const m = /pnpm\/(\S+)/.exec(agent);
  return m ? m[1] : "unknown";
}

export function buildManifest(root = process.cwd()) {
  const distDir = path.join(root, "dist");
  const { digest, fileCount, components } = computeArtifactDigest(distDir);
  return {
    schema: "sakthiai.release-artifact/v1",
    artifactDigest: digest,
    fileCount,
    components,
    buildEnvironment: buildEnvironmentFingerprint(),
    sourceCommit: sourceCommit(root),
    lockfileSha256: sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))),
    packageJsonSha256: sha256(readFileSync(path.join(root, "package.json"))),
    toolchain: { node: process.version, pnpm: pnpmVersion() },
    buildCommand: "pnpm install --frozen-lockfile && pnpm build",
    digestScope: "every file under dist/ except release-manifest.json",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const mode = process.argv[2] ?? "--write";
  const manifestPath = path.join(root, "dist", MANIFEST_NAME);
  if (!existsSync(path.join(root, "dist", "index.js"))) { console.error("RELEASE_MANIFEST_FAIL dist/index.js missing; run the build first"); process.exit(1); }
  if (mode === "--write") {
    const manifest = buildManifest(root);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`RELEASE_MANIFEST_WRITTEN digest=${manifest.artifactDigest} files=${manifest.fileCount} server=${manifest.components.server.digest} client=${manifest.components.client.digest} viteEnv=${manifest.buildEnvironment.fingerprint.slice(0, 16)} commit=${manifest.sourceCommit}`);
  } else if (mode === "--verify") {
    if (!existsSync(manifestPath)) { console.error("RELEASE_MANIFEST_FAIL manifest missing"); process.exit(1); }
    const recorded = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actual = computeArtifactDigest(path.join(root, "dist"));
    const ok = recorded.artifactDigest === actual.digest && recorded.fileCount === actual.fileCount
      && recorded.components?.server?.digest === actual.components.server.digest && recorded.components?.client?.digest === actual.components.client.digest;
    console.log(`RELEASE_MANIFEST_${ok ? "PASS" : "FAIL"} recorded=${recorded.artifactDigest} actual=${actual.digest} files=${actual.fileCount} server=${actual.components.server.digest}`);
    if (!ok) process.exit(1);
  } else { console.error("usage: release-manifest.mjs --write|--verify"); process.exit(2); }
}

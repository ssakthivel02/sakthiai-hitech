import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Identity of the built artifact this process is serving, reported on /releasez.
 * Mirrors scripts/release-manifest.mjs exactly (a test asserts both give the same digest): sha256 over sorted
 * "<sha256> <path>\n" lines of every file in the dist directory except the manifest. Recomputed once at startup, so a
 * build that was altered after the manifest was written reports verified=false and is not ready.
 */
export type ArtifactIdentity =
  | { state: "absent" }
  | {
      state: "verified" | "mismatch"; digest: string; recordedDigest: string; fileCount: number; manifestCommit: string;
      /** server = everything outside dist/public (runtime-configured); client = the browser bundle (embeds build-time VITE_* values) */
      serverDigest: string; clientDigest: string; buildEnvironmentFingerprint: string;
    };

const MANIFEST = "release-manifest.json";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

type Digest = { digest: string; fileCount: number };
export function computeArtifactDigest(distDir: string): Digest & { components: { server: Digest; client: Digest } } {
  const files = listFiles(distDir).filter(f => f !== MANIFEST).sort();
  const lines = files.map(f => `${sha256(readFileSync(path.join(distDir, f)))} ${f}\n`);
  const part = (keep: (f: string) => boolean): Digest => {
    const sel = lines.filter((_, i) => keep(files[i]!));
    return { digest: sha256(sel.join("")), fileCount: sel.length };
  };
  return {
    digest: sha256(lines.join("")), fileCount: files.length,
    components: { server: part(f => !f.startsWith("public/")), client: part(f => f.startsWith("public/")) },
  };
}

export function readArtifactIdentity(distDir: string): ArtifactIdentity {
  const manifestPath = path.join(distDir, MANIFEST);
  if (!existsSync(manifestPath)) return { state: "absent" };
  try {
    const recorded = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      artifactDigest?: string; sourceCommit?: string; buildEnvironment?: { fingerprint?: string };
      components?: { server?: { digest?: string }; client?: { digest?: string } };
    };
    const actual = computeArtifactDigest(distDir);
    const matches = recorded.artifactDigest === actual.digest
      && recorded.components?.server?.digest === actual.components.server.digest
      && recorded.components?.client?.digest === actual.components.client.digest;
    return {
      state: matches ? "verified" : "mismatch",
      digest: actual.digest,
      recordedDigest: String(recorded.artifactDigest ?? ""),
      fileCount: actual.fileCount,
      manifestCommit: String(recorded.sourceCommit ?? "unknown"),
      serverDigest: actual.components.server.digest,
      clientDigest: actual.components.client.digest,
      buildEnvironmentFingerprint: String(recorded.buildEnvironment?.fingerprint ?? ""),
    };
  } catch {
    return { state: "mismatch", digest: "", recordedDigest: "", fileCount: 0, manifestCommit: "unknown", serverDigest: "", clientDigest: "", buildEnvironmentFingerprint: "" };
  }
}

export function artifactIdentityReady(identity: ArtifactIdentity, runtimeCommit: string, production: boolean): boolean {
  if (!production) return identity.state !== "mismatch";
  if (identity.state !== "verified") return false;
  const commit = runtimeCommit.trim().toLowerCase();
  const manifestCommit = identity.manifestCommit.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(commit) && manifestCommit === commit;
}

let cached: ArtifactIdentity | null = null;
/** The dist directory is the directory of the running bundle (dist/index.js). In development there is no manifest. */
export function getArtifactIdentity(): ArtifactIdentity {
  cached ??= readArtifactIdentity(import.meta.dirname);
  return cached;
}

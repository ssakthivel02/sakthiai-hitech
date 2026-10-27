import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactIdentityReady, computeArtifactDigest, readArtifactIdentity } from "./artifactIdentity";
// @ts-expect-error plain ESM build script without type declarations
import { buildEnvironmentFingerprint, computeArtifactDigest as scriptDigest } from "../../scripts/release-manifest.mjs";

const dirs: string[] = [];
function fakeBuild() {
  const root = mkdtempSync(path.join(os.tmpdir(), "artifact-"));
  dirs.push(root);
  mkdirSync(path.join(root, "dist", "public", "assets"), { recursive: true });
  writeFileSync(path.join(root, "dist", "index.js"), "console.log('server');\n");
  writeFileSync(path.join(root, "dist", "public", "index.html"), "<!doctype html>");
  writeFileSync(path.join(root, "dist", "public", "assets", "app-abc.js"), "export {}");
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}
const script = path.resolve("scripts/release-manifest.mjs");
const run = (root: string, mode: string) => execFileSync("node", [script, mode], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_SHA: "f".repeat(40) } });

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("built-artifact identity", () => {
  it("the build script and the server compute the same digest over the same files", () => {
    const dist = path.join(fakeBuild(), "dist");
    expect(computeArtifactDigest(dist)).toEqual(scriptDigest(dist));
    expect(computeArtifactDigest(dist).fileCount).toBe(3);
    expect(computeArtifactDigest(dist).components).toMatchObject({ server: { fileCount: 1 }, client: { fileCount: 2 } });
  });

  it("a browser-bundle change moves only the client digest; the server digest is unaffected (and vice versa)", () => {
    const dist = path.join(fakeBuild(), "dist");
    const before = computeArtifactDigest(dist);
    appendFileSync(path.join(dist, "public", "assets", "app-abc.js"), "/*VITE value*/");
    const afterClient = computeArtifactDigest(dist);
    expect(afterClient.components.server.digest).toBe(before.components.server.digest);
    expect(afterClient.components.client.digest).not.toBe(before.components.client.digest);
    appendFileSync(path.join(dist, "index.js"), "//x");
    expect(computeArtifactDigest(dist).components.server.digest).not.toBe(before.components.server.digest);
  });

  it("the build environment is fingerprinted by VITE_* names and values, never written in clear", () => {
    const a = buildEnvironmentFingerprint({ VITE_OIDC_CLIENT_ID: "client-1", OTHER: "ignored", VITE_EMPTY: "" });
    expect(a.viteVariables).toEqual(["VITE_OIDC_CLIENT_ID"]);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain("client-1");
    expect(buildEnvironmentFingerprint({ VITE_OIDC_CLIENT_ID: "client-2" }).fingerprint).not.toBe(a.fingerprint);
    expect(buildEnvironmentFingerprint({ OTHER: "x" }).fingerprint).toBe(buildEnvironmentFingerprint({}).fingerprint);
  });

  it("a written manifest verifies, records source/lockfile/toolchain identity, and is excluded from its own digest", () => {
    const root = fakeBuild();
    expect(run(root, "--write")).toMatch(/RELEASE_MANIFEST_WRITTEN digest=[0-9a-f]{64} files=3 server=[0-9a-f]{64} client=[0-9a-f]{64} viteEnv=[0-9a-f]{16} commit=f{40}/);
    expect(run(root, "--verify")).toMatch(/RELEASE_MANIFEST_PASS/);
    const id = readArtifactIdentity(path.join(root, "dist"));
    expect(id).toMatchObject({ state: "verified", fileCount: 3, manifestCommit: "f".repeat(40), serverDigest: expect.stringMatching(/^[0-9a-f]{64}$/), buildEnvironmentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const manifest = JSON.parse(readFileSync(path.join(root, "dist", "release-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema: "sakthiai.release-artifact/v1", lockfileSha256: expect.stringMatching(/^[0-9a-f]{64}$/), packageJsonSha256: expect.stringMatching(/^[0-9a-f]{64}$/), toolchain: { node: process.version }, buildCommand: expect.stringContaining("--frozen-lockfile") });
  });

  it("any change to the built files after the manifest is written is detected (edit, add, remove)", () => {
    for (const tamper of [
      (d: string) => appendFileSync(path.join(d, "index.js"), "// injected\n"),
      (d: string) => writeFileSync(path.join(d, "public", "extra.js"), "x"),
      (d: string) => unlinkSync(path.join(d, "public", "index.html")),
    ]) {
      const root = fakeBuild();
      run(root, "--write");
      tamper(path.join(root, "dist"));
      expect(readArtifactIdentity(path.join(root, "dist")).state).toBe("mismatch");
      expect(() => run(root, "--verify")).toThrow();
    }
  });

  it("without a manifest (development) the identity is absent, not verified; a corrupt manifest is a mismatch", () => {
    const root = fakeBuild();
    expect(readArtifactIdentity(path.join(root, "dist"))).toEqual({ state: "absent" });
    writeFileSync(path.join(root, "dist", "release-manifest.json"), "{not json");
    expect(readArtifactIdentity(path.join(root, "dist")).state).toBe("mismatch");
  });

  it("production readiness requires a verified artifact bound to the exact runtime commit", () => {
    const commit = "a".repeat(40);
    expect(artifactIdentityReady({ state: "absent" }, commit, true)).toBe(false);
    expect(artifactIdentityReady({ state: "absent" }, "unknown", false)).toBe(true);
    const verified = {
      state: "verified" as const,
      digest: "d".repeat(64),
      recordedDigest: "d".repeat(64),
      fileCount: 3,
      manifestCommit: commit,
      serverDigest: "s".repeat(64),
      clientDigest: "c".repeat(64),
      buildEnvironmentFingerprint: "f".repeat(64),
    };
    expect(artifactIdentityReady(verified, commit, true)).toBe(true);
    expect(artifactIdentityReady(verified, "b".repeat(40), true)).toBe(false);
    expect(artifactIdentityReady({ ...verified, state: "mismatch" }, commit, true)).toBe(false);
  });
});

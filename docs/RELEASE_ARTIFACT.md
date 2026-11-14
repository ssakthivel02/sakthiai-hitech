# Built-artifact identity

A commit and a lockfile name the *inputs* of a build, not its output. This document defines how SakthiAI identifies the built artifact it deploys and how a running server proves which artifact it is.

## What is produced

`pnpm build` ends with `node scripts/release-manifest.mjs --write`, which writes `dist/release-manifest.json`:

| Field | Meaning |
|---|---|
| `artifactDigest` | sha256 over the sorted lines `"<sha256> <relative path>\n"` of every file under `dist/` except the manifest itself |
| `fileCount` | number of files covered |
| `components.server` | digest of every file outside `dist/public/` (chiefly `dist/index.js`, which reads its configuration at runtime) |
| `components.client` | digest of `dist/public/**`, the browser bundle, which embeds build-time `VITE_*` values |
| `buildEnvironment` | names of the non-empty `VITE_*` variables at build time and a sha256 fingerprint of `NAME=value` lines (values are never written) |
| `sourceCommit` | `RENDER_GIT_COMMIT`, else the checked-out `git rev-parse HEAD`, else `GITHUB_SHA` (not part of the digest) |
| `lockfileSha256`, `packageJsonSha256` | dependency inputs |
| `toolchain` | `node` version and `pnpm` version used for the build |
| `buildCommand` | `pnpm install --frozen-lockfile && pnpm build` |

`node scripts/release-manifest.mjs --verify` recomputes the digest and exits 1 on any difference.

## What the running server reports

At startup the server recomputes the digest of its own `dist/` (the directory of the running `dist/index.js`) and compares it with the manifest:

- `GET /releasez` returns `artifact: { state, digest, recordedDigest, fileCount, manifestCommit, serverDigest, clientDigest, buildEnvironmentFingerprint }`. `state` is `verified`, `mismatch` or `absent` (development, no manifest).
- `GET /readyz` is not ready when `state` is `mismatch` (files changed after the build), and lists `dependencies.artifact`.

## Where the artifact is retained

The `release-artifact` job in `quality-gate.yml` checks out the **exact deployable commit** (the PR head, not the merge ref the other jobs test, or the pushed commit), installs with the frozen lockfile, builds, verifies the manifest, starts the built server once and requires `/releasez` to report `verified`, then uploads `dist/` (including the manifest) as `release-artifact-<commit>` with 90-day retention. The digest, commit, lockfile hash and toolchain appear in that job's step summary.

The `release-evidence` job adds an `artifactIdentity` gate: its own independent rebuild must match its manifest and equal the digest that the smoke-tested server reported. It is a cross-runner reproducibility check on every run.

## Hosts that rebuild from source (Render)

The preview host builds from source, so the bytes it serves are not the bytes CI retained. The deployed build is tied to retained evidence by **digest equality**, component by component:

1. Read the served identity: `curl -s https://<host>/releasez`. Record `commit`, `artifact.serverDigest`, `artifact.clientDigest`, `artifact.buildEnvironmentFingerprint`, and confirm `artifact.state` is `verified`.
2. Open the `release-artifact-<commit>` artifact of a green Quality Gate run for that same commit and read its manifest.
3. **Server:** `serverDigest` must equal `components.server.digest`. The server bundle takes no build-time configuration, so a difference means the host built different server code (toolchain or inputs): the deploy is unqualified until explained.
4. **Client:** the browser bundle embeds `VITE_*` values. `clientDigest` must equal `components.client.digest` when `buildEnvironmentFingerprint` equals the manifest's `buildEnvironment.fingerprint`. To make that comparison possible, set the repository variables `SAKTHIAI_PREVIEW_VITE_APP_ID`, `SAKTHIAI_PREVIEW_VITE_OIDC_AUTHORIZATION_URL`, `SAKTHIAI_PREVIEW_VITE_OIDC_CLIENT_ID` and `SAKTHIAI_PREVIEW_VITE_OIDC_SCOPES` to the host's values (they are public: every browser receives them). Until then the fingerprints differ and only the server component is tied.

Measured locally (25 Oct 2026): builds of one commit in place and from a clean checkout in another directory gave the same digest. Setting two `VITE_OIDC_*` values changed 47 browser files and left `dist/index.js` unchanged, which is why the components are separate.

Limitations (stated, not hidden): equality depends on the host using the same Node major, pnpm version and lockfile (`render.yaml` pins `NODE_VERSION=22` and pnpm 10.4.1). The host's equality is unobserved until step 1 runs against a deployed build. To remove the dependency on host reproducibility entirely, deploy the retained artifact or a container image by digest instead of rebuilding. That is a hosting change this repository does not make.

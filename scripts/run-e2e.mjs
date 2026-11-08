#!/usr/bin/env node
// Production-shaped E2E: builds the client with the FAKE OIDC authorize URL baked in, then runs Playwright against the real built server.
// Needs TEST_DATABASE_URL (local/CI MySQL-compatible server). Never contacts a paid provider, a managed database or a deployment.
import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL) { console.error("E2E_FAIL: TEST_DATABASE_URL is required, e.g. mysql://root:pw@127.0.0.1:3306"); process.exit(2); }
const env = { ...process.env, VITE_OIDC_AUTHORIZATION_URL: "http://localhost:4311/authorize", VITE_OIDC_CLIENT_ID: "sakthiai-e2e", VITE_APP_ID: "sakthiai-e2e" };
const build = spawnSync("pnpm", ["build"], { stdio: "inherit", env });
if (build.status !== 0) process.exit(build.status ?? 1);
const run = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(run.status ?? 1);

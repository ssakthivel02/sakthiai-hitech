#!/usr/bin/env node
// Production source neutrality: forbidden vendor coupling must not appear in production-critical source (default) or the built output (--dist).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SOURCE = ["vite.config.ts", "render.yaml", "server/_core/index.ts", "server/_core/llm.ts", "server/_core/sdk.ts", "server/_core/oauth.ts", "server/storage.ts", "server/_core/storageProxy.ts", "client/src/const.ts", "client/src/_core/hooks/useAuth.ts"];
const SOURCE_PATTERN = "forge\\.manus\\.im|vite-plugin-manus-runtime|manuspre\\.computer|manus\\.computer|manus-asia\\.computer|manuscomputer\\.ai|manusvm\\.computer|WebDevAuthPublicService|/app-auth|OAUTH_SERVER_URL|types/manusTypes";
const DIST_PATTERN = "forge\\.manus\\.im|vite-plugin-manus-runtime|manuspre\\.computer|manus\\.computer|manus-asia\\.computer|manuscomputer\\.ai|manusvm\\.computer|BUILT_IN_FORGE|WebDevAuthPublicService|/app-auth|OAUTH_SERVER_URL|/manus-storage/|/__manus__/";
const dist = process.argv.includes("--dist");
const targets = dist ? ["dist"] : SOURCE.filter(existsSync);
if (dist && !existsSync("dist")) { console.error("NEUTRALITY_FAIL: dist/ is missing (run pnpm build first)"); process.exit(2); }
const run = spawnSync("grep", ["-REn", "-i", dist ? DIST_PATTERN : SOURCE_PATTERN, ...targets], { encoding: "utf8" });
if (run.status === 0) { console.error(`NEUTRALITY_FAIL: forbidden vendor coupling in ${dist ? "dist output" : "production-critical source"}:\n${run.stdout.split("\n").slice(0, 10).join("\n")}`); process.exit(1); }
if (run.status !== 1) { console.error(`NEUTRALITY_FAIL: scan error ${run.stderr}`); process.exit(2); }
console.log(`NEUTRALITY_PASS scope=${dist ? "dist" : "source"} files=${dist ? "dist/**" : targets.length}`);

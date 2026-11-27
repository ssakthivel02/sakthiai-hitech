#!/usr/bin/env node
// Checks an environment against the private-beta profile BEFORE it is applied to a deployment. Reads a dotenv-style file
// (--env-file) or the current environment. Prints variable names and messages only — never values.
//   node scripts/check-beta-profile.mjs --env-file ./beta.env [--model-activation]
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--env-file");
let env = process.env;
if (fileIndex >= 0) {
  env = {};
  for (const line of readFileSync(args[fileIndex + 1], "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { checkBetaProfile } = await tsImport("../server/ops/betaProfile.ts", import.meta.url);
const result = checkBetaProfile(env, { modelActivation: args.includes("--model-activation") });
for (const f of result.findings) console.log(`${f.level.toUpperCase().padEnd(4)} ${f.variable}: ${f.message}`);
console.log(result.ok ? "BETA_PROFILE_OK" : "BETA_PROFILE_FAIL");
process.exit(result.ok ? 0 : 1);

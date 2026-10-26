#!/usr/bin/env node
import { readFileSync } from "node:fs";

const path = ".github/workflows/private-beta-posture.yml";
const source = readFileSync(path, "utf8");

const forbidden = [
  [/secrets\./, "secret references"],
  [/^\s*environment\s*:/m, "protected/runtime environments"],
  [/\bdb:push\b/, "database migration commands"],
  [/\bwrangler\b/i, "Cloudflare deployment commands"],
  [/\brender\s+deploy\b/i, "Render deployment commands"],
  [/\baiven\b/i, "Aiven control commands"],
  [/curl\s+[^\n]*https?:\/\//i, "external HTTP calls"],
];

const required = [
  [/permissions:\s*\n\s*contents:\s*read/, "read-only repository permission"],
  [/server\/ops\/betaProfile\.test\.ts/, "private-beta profile tests"],
  [/server\/ops\/betaSourceImport\.static\.test\.ts/, "operator-only import isolation test"],
  [/scripts\/check-beta-profile\.mjs/, "runtime profile validator"],
];

const failures = [];
for (const [pattern, label] of forbidden) if (pattern.test(source)) failures.push(`forbidden: ${label}`);
for (const [pattern, label] of required) if (!pattern.test(source)) failures.push(`missing: ${label}`);

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("PRIVATE_BETA_POSTURE_WORKFLOW_SAFE");

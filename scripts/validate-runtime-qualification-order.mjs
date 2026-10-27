#!/usr/bin/env node
import { readFileSync } from "node:fs";

const runbookPath = "docs/INTEGRATION_RUNTIME_QUALIFICATION.md";
const contractPath = "release/preview-contract.json";
const readinessPath = "server/_core/index.ts";

const runbook = readFileSync(runbookPath, "utf8");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const readiness = readFileSync(readinessPath, "utf8");

const requiredHeadings = [
  "### Gate 3 — guarded read-only database inspect",
  "### Gate 4 — separately approve and apply reviewed migrations",
  "### Gate 5 — exact-commit deployment and readiness proof",
];
const positions = requiredHeadings.map(h => ({ h, i: runbook.indexOf(h) }));

const failures = [];
for (const { h, i } of positions) if (i < 0) failures.push(`missing runbook heading: ${h}`);
if (positions.every(x => x.i >= 0) && !(positions[0].i < positions[1].i && positions[1].i < positions[2].i)) {
  failures.push("runtime qualification order must be inspect -> migrate -> deploy/readiness");
}

for (const token of [
  "mode=inspect",
  "mode=migrate",
  "approved_commit=<exact SHA>",
  "database=schema_mismatch",
  "0013_rate_limit_windows",
]) {
  if (!runbook.includes(token)) failures.push(`runbook missing required control: ${token}`);
}

const gates = new Set(contract.requiredPreviewGates ?? []);
for (const gate of [
  "quality-gate",
  "private-beta-posture",
  "preview-deployment-preflight",
  "preview-db-setup",
  "preview-http-smoke",
]) {
  if (!gates.has(gate)) failures.push(`preview contract missing required gate: ${gate}`);
}
const readinessContract = contract.runtimeReadiness ?? {};
if (readinessContract.rateLimit !== "mysql-shared") failures.push("preview contract must require mysql-shared rate limiting");
if (readinessContract.artifact !== "verified-exact-commit") failures.push("preview contract must require a verified exact-commit artifact");
if (readinessContract.storage !== "configured-or-not-required-when-uploads-off") failures.push("preview contract must encode the upload-disabled storage posture");

for (const token of [
  "probeSchemaReadiness",
  'database: !databaseReady ? "unavailable" : schemaCurrent ? "configured" : "schema_mismatch"',
  "const ready = databaseReady && schemaCurrent",
]) {
  if (!readiness.includes(token)) failures.push(`readiness no longer proves current schema: ${token}`);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("RUNTIME_QUALIFICATION_ORDER_PASS");

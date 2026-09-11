import fs from 'node:fs';

const contract = JSON.parse(fs.readFileSync('release/preview-smoke-contract.json', 'utf8'));
const server = fs.readFileSync('server/_core/index.ts', 'utf8');
const render = fs.readFileSync('render.yaml', 'utf8');

const fail = (message) => { console.error(message); process.exit(1); };
const requireText = (source, text, message) => { if (!source.includes(text)) fail(message); };

for (const endpoint of contract.requiredEndpoints ?? []) requireText(server, `app.get("${endpoint}"`, `Missing operational endpoint ${endpoint}`);
requireText(server, 'status: "alive"', 'healthz must report alive');
requireText(server, 'res.status(ready ? 200 : 503)', 'readyz must fail closed with 503');
for (const dependency of contract.readiness.requiredDependencies ?? []) requireText(server, `${dependency}:`, `readyz missing dependency ${dependency}`);
requireText(server, 'exactCommitKnown: commit !== "unknown"', 'releasez must expose exact-commit truth');
requireText(server, 'repository: process.env.RENDER_GIT_REPO_SLUG?.trim() || "ssakthivel02/sakthiai-hitech"', 'releasez repository identity missing');
requireText(render, 'healthCheckPath: /readyz', 'Render health check must target /readyz');
requireText(render, 'autoDeployTrigger: off', 'Preview auto-deploy must remain disabled');
if (contract.deployment.productionApproval !== false) fail('Repository contract must not imply production approval');
if (contract.claimBoundary.repositoryValidationIsDeploymentProof !== false) fail('Repository validation must not be deployment proof');
if (contract.release.exactCommitRequiredForAcceptance !== true) fail('Exact deployed commit must be required for acceptance');
console.log('Preview smoke contract PASS');

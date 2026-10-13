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
requireText(server, 'environment: deploymentTier()', 'healthz/releasez must report the explicit deployment tier, never NODE_ENV');
if (server.includes('environment: process.env.NODE_ENV')) fail('Operational endpoints must not present NODE_ENV as the deployment environment');
requireText(render, 'key: SAKTHIAI_DEPLOY_ENV\n        value: preview', 'Render preview must declare SAKTHIAI_DEPLOY_ENV=preview');
requireText(server, 'repository: process.env.RENDER_GIT_REPO_SLUG?.trim() || "ssakthivel02/sakthiai-hitech"', 'releasez repository identity missing');
requireText(render, 'healthCheckPath: /healthz', 'Render platform health check must target /healthz; /readyz remains the explicit dependency-qualification endpoint');
requireText(render, 'autoDeployTrigger: off', 'Preview auto-deploy must remain disabled');
requireText(render, 'startCommand: exec node dist/index.js', 'Render must exec the built entry point: SIGTERM sent to a pnpm or non-exec shell wrapper bypasses the graceful shutdown handler');
if (/startCommand:.*\b(pnpm|npm|yarn|npx)\b/.test(render)) fail('Render startCommand must not run through a package-manager wrapper');
if (contract.deployment.productionApproval !== false) fail('Repository contract must not imply production approval');
if (contract.claimBoundary.repositoryValidationIsDeploymentProof !== false) fail('Repository validation must not be deployment proof');
if (contract.release.exactCommitRequiredForAcceptance !== true) fail('Exact deployed commit must be required for acceptance');
console.log('Preview smoke contract PASS');

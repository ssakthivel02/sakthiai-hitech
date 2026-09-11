import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const contract = JSON.parse(fs.readFileSync('release/secret-hygiene-contract.json', 'utf8'));
const fixtureArg = process.argv[2] === '--fixture' ? process.argv[3] : null;
const negativeFixture = 'release/fixtures/secret-hygiene-fail.txt';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (contract.productionApproval !== false) fail('Secret hygiene contract must not imply production approval');
for (const key of [
  'repositoryScanProvesNoHistoricalLeak',
  'repositoryScanProvesSecretRotation',
  'repositoryScanProvesExternalSecretStoreSafety',
]) {
  if (contract.claimBoundary?.[key] !== false) fail(`Unsafe secret-hygiene claim: ${key}`);
}

const patterns = [
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['openai-style-secret', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
];

function scan(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const [name, regex] of patterns) {
    if (regex.test(text)) fail(`High-confidence ${name} pattern found in ${path}`);
  }
}

if (fixtureArg) {
  scan(fixtureArg);
  console.log('Fixture unexpectedly passed');
  process.exit(0);
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

for (const path of files) {
  if (path === negativeFixture) continue;
  if (contract.forbidTrackedEnvFiles && /^\.env(?:\.|$)/.test(path) && path !== '.env.example') {
    fail(`Tracked environment file is forbidden: ${path}`);
  }
  scan(path);
}

if (!files.includes('.env.example')) fail('.env.example is required for safe configuration documentation');
const envExample = fs.readFileSync('.env.example', 'utf8');
const sensitiveNames = [
  'DATABASE_URL',
  'DATABASE_CA_CERT_B64',
  'OWNER_OPEN_ID',
  'OIDC_CLIENT_SECRET',
  'LLM_API_KEY',
  'EMBEDDING_API_KEY',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
];
for (const name of sensitiveNames) {
  const match = envExample.match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!match) fail(`.env.example missing sensitive configuration key ${name}`);
  const value = match[1].trim();
  if (value && !/^replace-with-/i.test(value)) fail(`.env.example must not contain a concrete value for ${name}`);
}
const jwt = envExample.match(/^JWT_SECRET=(.*)$/m)?.[1]?.trim() ?? '';
if (!/^replace-with-/i.test(jwt)) fail('.env.example JWT_SECRET must remain an explicit placeholder');

console.log(`Secret hygiene PASS: scanned ${files.length - 1} tracked paths plus safe .env.example policy`);

import fs from 'node:fs';
import crypto from 'node:crypto';

const specPath = 'research/evaluation/video-seam-quality-spec.json';
const reviewPath = process.argv[2];
if (!reviewPath) {
  console.error('Usage: node scripts/validate-video-seam-quality.mjs <review.json>');
  process.exit(2);
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitBlobSha(file) {
  const body = fs.readFileSync(file);
  const header = Buffer.from(`blob ${body.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

const spec = readJson(specPath);
const review = readJson(reviewPath);
if (review.specId !== spec.stableId) throw new Error(`specId must be ${spec.stableId}`);
if (spec.runtimeApproved !== false || spec.productionApproved !== false) throw new Error('Seam quality spec must remain non-runtime and non-production-approved');
if (spec.policy?.providerNeutral !== true || spec.policy?.paidProviderActivation !== false) throw new Error('Seam quality policy must remain provider-neutral and paid-provider-disabled');

const assemblyRef = review.assemblyManifest;
if (!assemblyRef || typeof assemblyRef !== 'object') throw new Error('assemblyManifest traceability is required');
if (typeof assemblyRef.path !== 'string' || !assemblyRef.path.startsWith('research/evaluation/fixtures/') || !assemblyRef.path.endsWith('.json')) throw new Error('assemblyManifest.path must point to a governed evaluation fixture');
if (!/^[0-9a-f]{40}$/.test(assemblyRef.gitBlobSha ?? '')) throw new Error('assemblyManifest.gitBlobSha must be a lowercase 40-character Git blob SHA');
if (!fs.existsSync(assemblyRef.path)) throw new Error(`Assembly manifest not found: ${assemblyRef.path}`);
const assemblySha = gitBlobSha(assemblyRef.path);
if (assemblySha !== assemblyRef.gitBlobSha) throw new Error(`Assembly manifest drift detected: expected ${assemblyRef.gitBlobSha}, got ${assemblySha}`);
const assembly = readJson(assemblyRef.path);
if (assembly.requestId !== review.requestId) throw new Error('Review requestId must match assembly manifest requestId');
if (assembly.transitionPolicy !== 'CUT_ONLY') throw new Error('This seam fixture expects the governed CUT_ONLY assembly policy');
if (assembly.policy?.productionApproved !== false || assembly.policy?.paidProviderApproved !== false) throw new Error('Assembly manifest cannot self-approve production or paid-provider use');

if (!review.reviewer || !['HUMAN', 'ASSISTED_HUMAN'].includes(review.reviewer.type)) throw new Error('reviewer.type must be HUMAN or ASSISTED_HUMAN');
if (!review.reviewer.reviewTimestamp) throw new Error('reviewer.reviewTimestamp is required');
if (review.productionApproved !== false || review.paidProviderApproved !== false) throw new Error('Seam review cannot self-approve production or paid-provider use');

const shots = assembly.shots ?? [];
if (shots.length < 2) throw new Error('Seam review requires at least two assembled shots');
const expectedPairs = shots.slice(0, -1).map((shot, index) => `${shot.shotId}->${shots[index + 1].shotId}`);
const seams = review.seams ?? [];
if (seams.length !== expectedPairs.length) throw new Error(`Expected exactly ${expectedPairs.length} seam reviews, got ${seams.length}`);

const dimensions = spec.dimensions ?? [];
if (dimensions.length === 0) throw new Error('Seam quality spec has no dimensions');
const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
if (totalWeight !== 100) throw new Error(`Seam dimension weights must total 100, got ${totalWeight}`);
const locked = new Set(spec.scoring?.lockedDimensions ?? []);
const seenPairs = new Set();
let overallPass = true;
const seamResults = [];

for (let index = 0; index < seams.length; index += 1) {
  const seam = seams[index];
  const pair = `${seam.fromShotId}->${seam.toShotId}`;
  if (pair !== expectedPairs[index]) throw new Error(`Seam ${index + 1} must review ${expectedPairs[index]}, got ${pair}`);
  if (seenPairs.has(pair)) throw new Error(`Duplicate seam review: ${pair}`);
  seenPairs.add(pair);

  const criticalDefects = Array.isArray(seam.criticalDefects) ? seam.criticalDefects.filter(Boolean) : [];
  let weightedScore = 0;
  let dimensionPass = true;
  for (const dimension of dimensions) {
    const score = seam.dimensionScores?.[dimension.id];
    if (typeof score !== 'number' || score < 0 || score > 5) throw new Error(`${pair} ${dimension.id} score must be between 0 and 5`);
    weightedScore += (score / 5) * dimension.weight;
    const minimum = locked.has(dimension.id) ? spec.scoring.lockedContinuityMinimum : spec.scoring.minimumPerDimensionScore;
    if (score < minimum) dimensionPass = false;
  }
  weightedScore = Number(weightedScore.toFixed(2));
  const pass = criticalDefects.length === 0 && dimensionPass && weightedScore >= spec.scoring.minimumWeightedScore;
  if (!pass) overallPass = false;
  seamResults.push({ pair, weightedScore, criticalDefectCount: criticalDefects.length, pass });
}

const computedDecision = overallPass ? 'PASS' : 'REASSEMBLE_OR_REGENERATE';
if (review.decision !== computedDecision) throw new Error(`Recorded decision ${review.decision} does not match computed decision ${computedDecision}`);
if (computedDecision !== 'PASS') throw new Error(`Cross-shot seam quality failed: ${JSON.stringify(seamResults)}`);

console.log(JSON.stringify({
  specId: spec.stableId,
  requestId: review.requestId,
  assemblyManifest: { path: assemblyRef.path, gitBlobSha: assemblySha, traceabilityVerified: true },
  reviewedSeams: seamResults,
  decision: computedDecision,
  productionApproved: false,
  paidProviderApproved: false
}, null, 2));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const request = 'research/generative-media/fixtures/video-generation-request-pass.json';
const review = 'research/evaluation/fixtures/video-shot-review-selective-regeneration.json';
const manifest = 'research/evaluation/fixtures/video-assembly-selective-regeneration.json';

const goodOutput = execFileSync(process.execPath, [
  'scripts/validate-video-assembly-manifest.mjs', request, review, manifest,
], { encoding: 'utf8' });
const good = JSON.parse(goodOutput);

if (good.decision !== 'ASSEMBLY_MANIFEST_VALID') throw new Error(`Unexpected assembly decision ${good.decision}`);
if (JSON.stringify(good.preservedShotIds) !== JSON.stringify(['SHOT-001', 'SHOT-003'])) throw new Error('Accepted shots were not preserved correctly');
if (JSON.stringify(good.regeneratedShotIds) !== JSON.stringify(['SHOT-002'])) throw new Error('Only SHOT-002 should be regenerated');
if (good.totalDurationSeconds !== 12) throw new Error(`Expected 12s assembled duration, got ${good.totalDurationSeconds}`);
if (good.productionApproved !== false || good.paidProviderApproved !== false) throw new Error('Assembly validation cannot grant production or paid-provider approval');

const tampered = JSON.parse(fs.readFileSync(manifest, 'utf8'));
tampered.shots[1].sourceType = 'ORIGINAL_ACCEPTED';
const tamperedPath = path.join(os.tmpdir(), `sakthiai-video-assembly-tampered-${process.pid}.json`);
fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));
let rejected = false;
try {
  execFileSync(process.execPath, [
    'scripts/validate-video-assembly-manifest.mjs', request, review, tamperedPath,
  ], { encoding: 'utf8', stdio: 'pipe' });
} catch {
  rejected = true;
} finally {
  fs.rmSync(tamperedPath, { force: true });
}
if (!rejected) throw new Error('Tampered assembly manifest unexpectedly passed');

console.log('VIDEO_ASSEMBLY_INTEGRITY_GATE_PASS preserve=SHOT-001,SHOT-003 regenerate=SHOT-002 tamperRejected=true');

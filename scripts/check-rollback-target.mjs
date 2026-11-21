#!/usr/bin/env node
// Decides whether a commit may serve as an application rollback target, or whether the operator must CONTAIN instead
// (suspend the service or enable maintenance mode). Pure evaluation is exported for tests; the CLI reads git and the
// guard's live-journal report. It never deploys, restores or changes anything.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ADDITIVE = /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE `[^`]+` ADD )/i;

/**
 * @param {object} input
 * @param {object} input.contract          release/rollback-contract.json
 * @param {string} input.target            40-char commit SHA proposed as the rollback target
 * @param {boolean} input.containsBaseline target has securityBaseline.minimumCommit as an ancestor (or is it)
 * @param {Array<{tag:string,hash:string}>} input.targetJournal   migrations the target build expects
 * @param {Array<{tag:string,hash:string,statements:string[]}>} input.candidateJournal migrations of the build being rolled back
 * @param {string[]} input.liveHashes      __drizzle_migrations hashes actually applied to the live database, in order
 * @param {boolean} [input.targetVerifiedLive] the target previously served this environment and passed acceptance
 */
export function evaluateRollbackTarget({ contract, target, containsBaseline, targetJournal, candidateJournal, liveHashes, targetVerifiedLive = false }) {
  const problems = [];
  if (!SHA.test(target ?? '')) problems.push('target must be a full 40-character commit SHA');
  const forbidden = (contract.securityBaseline?.forbiddenTargets ?? []).find(f => f.commit === target);
  if (forbidden) problems.push(`target is forbidden: ${forbidden.reason}`);
  if (!containsBaseline) problems.push(`target does not contain the security baseline ${contract.securityBaseline?.minimumCommit}`);

  // The target's expected schema must be a prefix of the candidate journal (same tags and file hashes) ...
  for (let i = 0; i < targetJournal.length; i++) {
    const t = targetJournal[i]; const c = candidateJournal[i];
    if (!c || c.tag !== t.tag || c.hash !== t.hash) { problems.push(`target migration ${t.tag} is not identical to the candidate's migration at position ${i}`); break; }
  }
  // ... and already applied to the live database, in order (an older build must never need a migration the DB lacks).
  for (let i = 0; i < targetJournal.length; i++) {
    if (liveHashes[i] !== targetJournal[i].hash) { problems.push(`live database does not have ${targetJournal[i].tag} applied at position ${i}`); break; }
  }
  // Everything applied after the target's prefix must be additive, so the older build still works against it.
  for (const entry of candidateJournal.slice(targetJournal.length, liveHashes.length)) {
    const bad = entry.statements.find(s => !ADDITIVE.test(s.trim()));
    if (bad) problems.push(`${entry.tag} is applied but not purely additive; an application rollback past it needs a database restore plan`);
  }
  const ok = problems.length === 0;
  return {
    ok,
    decision: ok ? 'rollback-to-target' : 'contain',
    containment: ok ? [] : contract.containment?.whenNoQualifiedTarget ?? ['suspend-service'],
    evidenceClass: ok ? (targetVerifiedLive ? 'previously-live-verified' : 'ci-verified-only: run full post-rollback acceptance') : 'not-qualified',
    problems,
  };
}

function journalAt(ref, root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const journal = JSON.parse(git('show', `${ref}:drizzle/meta/_journal.json`));
  return journal.entries.map(e => {
    const text = git('show', `${ref}:drizzle/${e.tag}.sql`);
    return { tag: e.tag, hash: createHash('sha256').update(text).digest('hex'), statements: text.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [target, liveReport, candidate = 'HEAD'] = process.argv.slice(2);
  if (!target || !liveReport) {
    console.error('usage: check-rollback-target.mjs <target-sha> <preview-migration-(pre|post).json from the live database> [candidate-ref]');
    process.exit(2);
  }
  const root = process.cwd();
  const contract = JSON.parse(readFileSync(path.join(root, 'release/rollback-contract.json'), 'utf8'));
  let containsBaseline = false;
  try { execFileSync('git', ['merge-base', '--is-ancestor', contract.securityBaseline.minimumCommit, target], { cwd: root }); containsBaseline = true; } catch { containsBaseline = false; }
  const report = JSON.parse(readFileSync(liveReport, 'utf8'));
  const liveHashes = (report.snapshot?.journal ?? []).map(j => j.hash);
  const result = evaluateRollbackTarget({ contract, target, containsBaseline, targetJournal: journalAt(target, root), candidateJournal: journalAt(candidate, root), liveHashes });
  console.log(JSON.stringify({ target, candidate, ...result }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

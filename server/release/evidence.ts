import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Release-evidence consolidation. Pure functions (no network, no process spawning) so the gate logic is itself tested.
 * Principles: every gate is PASS / FAIL / MISSING, never inferred; local runs can never claim CI; nothing here can ever
 * claim RUNTIME_VERIFIED (that needs a real deployed runtime this repository cannot observe).
 */
export const MANIFEST_SCHEMA = "sakthiai.release-evidence/v1";
export type GateStatus = "PASS" | "FAIL" | "MISSING" | "ATTESTED" | "NOT_ATTESTED";
export type Gate = { status: GateStatus; detail: string; digest?: string };
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const fileDigest = (file: string) => (existsSync(file) ? sha256(readFileSync(file)) : null);
export const readJson = <T = any>(file: string): T | null => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; } };

// ---------- migrations ----------
export type MigrationReport = { ok: boolean; ids: string[]; problems: string[]; sqlDigest: string };
export function checkMigrations(root = "."): MigrationReport {
  const problems: string[] = []; const dir = path.join(root, "drizzle");
  const journal = readJson<{ entries: Array<{ idx: number; tag: string; when: number }> }>(path.join(dir, "meta/_journal.json"));
  if (!journal) return { ok: false, ids: [], problems: ["journal missing or unreadable"], sqlDigest: "" };
  const ids = journal.entries.map(e => e.tag); const seen = new Set<string>(); let lastWhen = -Infinity; const all: string[] = [];
  journal.entries.forEach((e, i) => {
    if (e.idx !== i) problems.push(`journal idx ${e.idx} at position ${i}`);
    if (seen.has(e.tag)) problems.push(`duplicate tag ${e.tag}`); seen.add(e.tag);
    if (!(e.when > lastWhen)) problems.push(`journal "when" not strictly increasing at ${e.tag}`); lastWhen = e.when;
    if (!/^\d{4}_[a-z0-9_]+$/.test(e.tag) || Number(e.tag.slice(0, 4)) !== i) problems.push(`tag ${e.tag} does not match its position ${i}`);
    const file = path.join(dir, `${e.tag}.sql`);
    if (!existsSync(file)) problems.push(`missing SQL for ${e.tag}`); else all.push(sha256(readFileSync(file)));
  });
  const sqlFiles = readdirSync(dir).filter(f => f.endsWith(".sql"));
  for (const f of sqlFiles) if (!seen.has(f.replace(/\.sql$/, ""))) problems.push(`orphan migration file ${f} not in the journal`);
  for (const f of readdirSync(dir)) if (/(^|[._-])(down|rollback|revert)([._-]|$)/i.test(f)) problems.push(`down/rollback artefact ${f} (migrations are forward-only)`);
  // every table declared in drizzle/schema.ts must be created by some migration (the column-level drift test runs on real SQL in test:mysql)
  const schemaFile = path.join(dir, "schema.ts");
  if (existsSync(schemaFile)) {
    const declared = [...readFileSync(schemaFile, "utf8").matchAll(/mysqlTable\(\s*"([A-Za-z0-9_]+)"/g)].map(m => m[1]);
    const created = new Set(ids.flatMap(tag => existsSync(path.join(dir, `${tag}.sql`)) ? [...readFileSync(path.join(dir, `${tag}.sql`), "utf8").matchAll(/CREATE TABLE `([A-Za-z0-9_]+)`/g)].map(m => m[1]) : []));
    for (const t of declared) if (!created.has(t)) problems.push(`schema table ${t} is not created by any migration`);
  } else problems.push("drizzle/schema.ts missing");
  return { ok: problems.length === 0, ids, problems, sqlDigest: sha256(all.join("\n")) };
}

// ---------- capability map ----------
export type CapabilityTruth = { ok: boolean; total: number; byTruthModel: Record<string, number>; byStatus: Record<string, number>; runtimeVerified: string[]; ciVerified: string[]; problems: string[] };
export function checkCapabilityMap(map: any, root = "."): CapabilityTruth {
  const problems: string[] = []; const byTruthModel: Record<string, number> = {}; const byStatus: Record<string, number> = {};
  const caps: any[] = Array.isArray(map?.capabilities) ? map.capabilities : []; if (!caps.length) problems.push("capability map has no capabilities");
  const ids = new Set<string>(); const runtimeVerified: string[] = []; const ciVerified: string[] = [];
  for (const c of caps) {
    if (ids.has(c.capability)) problems.push(`duplicate capability ${c.capability}`); ids.add(c.capability);
    if (!map.vocabulary?.truthModel?.includes(c.truthModel)) problems.push(`${c.capability}: truthModel ${c.truthModel} outside vocabulary`);
    if (!map.vocabulary?.status?.includes(c.status)) problems.push(`${c.capability}: status ${c.status} outside vocabulary`);
    for (const f of ["runtimePath", "knownLimitation"]) if (typeof c[f] !== "string" || c[f].length < 10) problems.push(`${c.capability}: ${f} missing`);
    for (const f of ["sourceFiles", "tests", "workflowGate"]) if (!Array.isArray(c[f]) || !c[f].length) problems.push(`${c.capability}: ${f} empty`);
    for (const f of [...(c.sourceFiles ?? []), ...(c.tests ?? [])]) if (!existsSync(path.join(root, f))) problems.push(`${c.capability}: referenced file ${f} does not exist`);
    if (c.status === "RUNTIME_VERIFIED" || c.runtimeQualification === "RUNTIME_VERIFIED") runtimeVerified.push(c.capability);
    if (c.ci && c.ci !== "CI_PENDING") ciVerified.push(c.capability);
    byTruthModel[c.truthModel] = (byTruthModel[c.truthModel] ?? 0) + 1; byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }
  // The repository cannot observe a deployed runtime or a GitHub run, so any such claim in a source file is unevidenced.
  for (const id of runtimeVerified) problems.push(`${id}: claims RUNTIME_VERIFIED without runtime evidence`);
  for (const id of ciVerified) problems.push(`${id}: claims a CI status other than CI_PENDING in a source file`);
  return { ok: problems.length === 0, total: caps.length, byTruthModel, byStatus, runtimeVerified, ciVerified, problems };
}

// ---------- report summarisers ----------
export type TestTotals = { present: boolean; files: number; filesFailed: number; total: number; passed: number; failed: number; skipped: number };
export function summarizeVitest(report: any): TestTotals {
  if (!report || typeof report.numTotalTests !== "number") return { present: false, files: 0, filesFailed: 0, total: 0, passed: 0, failed: 0, skipped: 0 };
  const files = Array.isArray(report.testResults) ? report.testResults : [];
  return { present: true, files: files.length, filesFailed: files.filter((f: any) => f.status === "failed").length, total: report.numTotalTests, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0, skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0) };
}
export type E2eTotals = { present: boolean; expected: number; unexpected: number; flaky: number; skipped: number };
export function summarizePlaywright(report: any): E2eTotals {
  const s = report?.stats; if (!s || typeof s.expected !== "number") return { present: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  return { present: true, expected: s.expected, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0 };
}
export type AuditCounts = { present: boolean; info: number; low: number; moderate: number; high: number; critical: number };
export function summarizeAudit(report: any): AuditCounts {
  const v = report?.metadata?.vulnerabilities; if (!v || typeof v !== "object") return { present: false, info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  return { present: true, info: v.info ?? 0, low: v.low ?? 0, moderate: v.moderate ?? 0, high: v.high ?? 0, critical: v.critical ?? 0 };
}

// ---------- manifest ----------
export type EvidenceInputs = {
  gitSha: string; gitDirty: boolean; node: string; pnpm: string; generatedAt: string;
  ci: { actions: boolean; runId?: string; runAttempt?: string; workflow?: string; ref?: string; sha?: string; upstreamJobsSucceeded: string[] };
  files: { lockfile: string | null; packageJson: string | null };
  migrations: MigrationReport; capability: CapabilityTruth;
  unit: TestTotals; mysql: TestTotals; e2e: E2eTotals; audit: AuditCounts;
  evalReport: any; goldenReport: any; recoveryReport: any; smoke: any;
  evalDigest: string | null; goldenDigest: string | null; e2eDigest: string | null; recoveryDigest: string | null;
  secretHygiene: { ok: boolean; detail: string } | null; sourceNeutrality: { ok: boolean; detail: string } | null;
};

export const REQUIRED_JOBS = ["validate", "mysql-integration", "e2e"] as const;
const gate = (status: GateStatus, detail: string, digest?: string): Gate => ({ status, detail, ...(digest ? { digest } : {}) });
const testsGate = (t: TestTotals, label: string): Gate => !t.present ? gate("MISSING", `${label} report missing`) : t.failed || t.filesFailed ? gate("FAIL", `${t.failed} failed tests in ${t.filesFailed} files`) : t.total === 0 ? gate("FAIL", "zero tests ran") : gate("PASS", `${t.passed}/${t.total} passed, ${t.skipped} skipped, ${t.files} files`);

export function buildManifest(i: EvidenceInputs) {
  const attested = i.ci.actions && i.ci.upstreamJobsSucceeded.length > 0;
  const shaMatches = !i.ci.actions || !i.ci.sha || i.ci.sha === i.gitSha;
  const jobAttest = (job: string, what: string): Gate => attested && i.ci.upstreamJobsSucceeded.includes(job) ? gate("ATTESTED", `${what}: upstream CI job "${job}" succeeded for this run`) : gate("NOT_ATTESTED", `${what}: not attested (needs a successful GitHub Actions job "${job}")`);
  const gates: Record<string, Gate> = {
    upstreamJobs: attested && REQUIRED_JOBS.every(j => i.ci.upstreamJobsSucceeded.includes(j)) ? gate("ATTESTED", `all required upstream CI jobs succeeded: ${REQUIRED_JOBS.join(", ")}`) : gate("NOT_ATTESTED", `needs successful GitHub Actions jobs: ${REQUIRED_JOBS.join(", ")}`),
    frozenInstall: jobAttest("validate", "pnpm install --frozen-lockfile"),
    typecheck: jobAttest("validate", "pnpm check"),
    unitTests: testsGate(i.unit, "unit test"),
    mysqlIntegration: testsGate(i.mysql, "MySQL integration"),
    e2e: !i.e2e.present ? gate("MISSING", "Playwright report missing") : i.e2e.unexpected || i.e2e.flaky ? gate("FAIL", `${i.e2e.unexpected} failed, ${i.e2e.flaky} flaky`) : i.e2e.expected === 0 ? gate("FAIL", "zero e2e tests ran") : gate("PASS", `${i.e2e.expected} passed, ${i.e2e.skipped} skipped`, i.e2eDigest ?? undefined),
    evals: !i.evalReport ? gate("MISSING", "contract eval report missing") : i.evalReport.thresholds?.passed === true && i.evalReport.evidenceClass === "CONTRACT_HARNESS" && i.evalReport.realModelQuality === "NOT_MEASURED" ? gate("PASS", `${i.evalReport.aggregates?.casesPassed}/${i.evalReport.aggregates?.cases} contract cases`, i.evalDigest ?? undefined) : gate("FAIL", "contract eval thresholds failed or report overclaims"),
    goldenBenchmark: !i.goldenReport ? gate("MISSING", "golden benchmark report missing") : i.goldenReport.thresholds?.passed === true && i.goldenReport.realModelQuality === "REAL_MODEL_QUALITY_UNVERIFIED" && i.goldenReport.evidenceClass === "CONTRACT_HARNESS_GOLDEN" ? gate("PASS", `${i.goldenReport.aggregates?.scoredPassed}/${i.goldenReport.aggregates?.scoredCases} scored, ${i.goldenReport.aggregates?.knownGapCases} known gaps`, i.goldenDigest ?? undefined) : gate("FAIL", "golden thresholds failed or report overclaims"),
    recoveryRehearsal: !i.recoveryReport ? gate("MISSING", "recovery rehearsal report missing") : i.recoveryReport.passed === true && i.recoveryReport.managedDatabaseTouched === false && i.recoveryReport.schemaDowngrade === "NOT_SUPPORTED_FORWARD_ONLY" ? gate("PASS", `${i.recoveryReport.scenarios?.length} scenarios on ${i.recoveryReport.engine}`, i.recoveryDigest ?? undefined) : gate("FAIL", "recovery rehearsal failed or overclaims"),
    capabilityMap: i.capability.ok ? gate("PASS", `${i.capability.total} capabilities, 0 runtime-verified claims`) : gate("FAIL", i.capability.problems.slice(0, 3).join("; ")),
    migrationConsistency: i.migrations.ok ? gate("PASS", `${i.migrations.ids.length} migrations, journal/SQL/schema consistent, forward-only`, i.migrations.sqlDigest) : gate("FAIL", i.migrations.problems.slice(0, 3).join("; ")),
    secretHygiene: !i.secretHygiene ? gate("MISSING", "secret hygiene scan not run") : i.secretHygiene.ok ? gate("PASS", i.secretHygiene.detail) : gate("FAIL", i.secretHygiene.detail),
    sourceNeutrality: !i.sourceNeutrality ? gate("MISSING", "source neutrality guard not run") : i.sourceNeutrality.ok ? gate("PASS", i.sourceNeutrality.detail) : gate("FAIL", i.sourceNeutrality.detail),
    productionAdvisories: !i.audit.present ? gate("MISSING", "pnpm audit --prod report missing") : i.audit.critical || i.audit.high ? gate("FAIL", `${i.audit.critical} critical, ${i.audit.high} high production advisories`) : gate("PASS", `0 critical, 0 high (${i.audit.moderate} moderate, ${i.audit.low} low)`),
    build: i.smoke?.distPresent === true ? gate("PASS", "dist/index.js present") : i.smoke ? gate("FAIL", "dist missing") : gate("MISSING", "built-server smoke not run"),
    builtServerSmoke: !i.smoke ? gate("MISSING", "built-server smoke not run") : i.smoke.ok === true ? gate("PASS", `healthz ${i.smoke.healthz}, root ${i.smoke.rootBytes} bytes, readyz ${i.smoke.readyz} (fail-closed expected)`) : gate("FAIL", String(i.smoke.detail ?? "smoke failed")),
    ciShaBinding: i.ci.actions ? (shaMatches ? gate("PASS", "GITHUB_SHA equals checked-out HEAD") : gate("FAIL", "GITHUB_SHA differs from checked-out HEAD")) : gate("NOT_ATTESTED", "not running in GitHub Actions"),
  };
  const required = Object.keys(gates);
  const hardFail = required.filter(k => gates[k].status === "FAIL");
  const missing = required.filter(k => gates[k].status === "MISSING");
  const notAttested = required.filter(k => gates[k].status === "NOT_ATTESTED");
  const localEvidenceOk = ["unitTests", "mysqlIntegration", "e2e", "evals", "goldenBenchmark", "recoveryRehearsal", "capabilityMap", "migrationConsistency", "secretHygiene", "sourceNeutrality", "productionAdvisories", "build", "builtServerSmoke"].every(k => gates[k].status === "PASS");
  const ciVerified = i.ci.actions && !i.gitDirty && hardFail.length === 0 && missing.length === 0 && notAttested.length === 0 && shaMatches;
  const overall = hardFail.length ? "GATES_FAILED" : missing.length ? "GATES_INCOMPLETE" : ciVerified ? "CI_GATES_PASS" : "LOCAL_GATES_PASS_CI_PENDING";
  return {
    schema: MANIFEST_SCHEMA, generatedAt: i.generatedAt,
    source: { gitSha: i.gitSha, dirtyWorkingTree: i.gitDirty, node: i.node, pnpm: i.pnpm, lockfileSha256: i.files.lockfile, packageJsonSha256: i.files.packageJson },
    environment: i.ci.actions ? { kind: "GITHUB_ACTIONS", runId: i.ci.runId ?? null, runAttempt: i.ci.runAttempt ?? null, workflow: i.ci.workflow ?? null, ref: i.ci.ref ?? null, upstreamJobsSucceeded: i.ci.upstreamJobsSucceeded } : { kind: "LOCAL", note: "produced outside GitHub Actions; cannot establish CI status" },
    claims: {
      SOURCE_IMPLEMENTED: true,
      LOCALLY_TESTED: localEvidenceOk,
      CI_VERIFIED: ciVerified,
      CI_STATUS: ciVerified ? "CI_VERIFIED_THIS_RUN" : "CI_PENDING",
      RUNTIME_VERIFIED: false,
      RUNTIME_STATUS: "RUNTIME_UNVERIFIED",
      runtimeNote: "No capability is runtime-verified: that requires a deployed runtime, a real scanner/model/storage and a human decision, none of which this manifest can observe.",
    },
    tests: { unit: i.unit, mysqlIntegration: i.mysql, e2e: i.e2e },
    migrations: { ids: i.migrations.ids, count: i.migrations.ids.length, latest: i.migrations.ids[i.migrations.ids.length - 1] ?? null, sqlDigest: i.migrations.sqlDigest },
    evals: { contract: i.evalReport ? { digest: i.evalDigest, evidenceClass: i.evalReport.evidenceClass, cases: i.evalReport.aggregates?.cases, passed: i.evalReport.aggregates?.casesPassed, realModelQuality: i.evalReport.realModelQuality } : null,
      golden: i.goldenReport ? { digest: i.goldenDigest, corpusDigest: i.goldenReport.corpusDigest, evidenceClass: i.goldenReport.evidenceClass, scored: `${i.goldenReport.aggregates?.scoredPassed}/${i.goldenReport.aggregates?.scoredCases}`, knownGaps: i.goldenReport.aggregates?.knownGapCases, realModelQuality: i.goldenReport.realModelQuality } : null },
    e2e: { digest: i.e2eDigest, ...i.e2e },
    audit: { scope: "production dependencies (pnpm audit --prod)", ...i.audit },
    recovery: i.recoveryReport ? { digest: i.recoveryDigest, evidenceClass: i.recoveryReport.evidenceClass, engine: i.recoveryReport.engine, scenarios: i.recoveryReport.scenarios?.length, managedDatabaseTouched: i.recoveryReport.managedDatabaseTouched, schemaDowngrade: i.recoveryReport.schemaDowngrade } : null,
    capabilityTruth: { total: i.capability.total, byTruthModel: i.capability.byTruthModel, byStatus: i.capability.byStatus, runtimeVerified: i.capability.runtimeVerified, ciVerified: i.capability.ciVerified },
    gates, summary: { overall, failed: hardFail, missing, notAttested },
  };
}
export type ReleaseManifest = ReturnType<typeof buildManifest>;

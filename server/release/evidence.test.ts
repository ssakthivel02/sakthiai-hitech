import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, checkCapabilityMap, checkMigrations, readJson, summarizeAudit, summarizePlaywright, summarizeVitest, type EvidenceInputs } from "./evidence";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(over: { journal?: any[]; files?: Record<string, string>; schema?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rel-")); dirs.push(root); mkdirSync(path.join(root, "drizzle/meta"), { recursive: true });
  const journal = over.journal ?? [{ idx: 0, tag: "0000_a", when: 1 }, { idx: 1, tag: "0001_b", when: 2 }];
  writeFileSync(path.join(root, "drizzle/meta/_journal.json"), JSON.stringify({ entries: journal }));
  const files = over.files ?? { "0000_a.sql": "CREATE TABLE `alpha` (id int);", "0001_b.sql": "CREATE TABLE `beta` (id int);" };
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(root, "drizzle", f), c);
  writeFileSync(path.join(root, "drizzle/schema.ts"), over.schema ?? 'export const a = mysqlTable("alpha", {}); export const b = mysqlTable("beta", {});');
  return root;
}

describe("migration consistency", () => {
  it("passes for the real repository and for a clean fixture", () => {
    const real = checkMigrations("."); expect(real.problems).toEqual([]); expect(real.ids.length).toBeGreaterThanOrEqual(11);
    expect(checkMigrations(repo()).ok).toBe(true);
  });
  it("detects duplicate tags, wrong position, non-monotonic time, missing SQL, orphan SQL, undeclared schema tables and down artefacts", () => {
    const p = (r: string) => checkMigrations(r).problems.join("|");
    expect(p(repo({ journal: [{ idx: 0, tag: "0000_a", when: 1 }, { idx: 1, tag: "0000_a", when: 2 }] }))).toMatch(/duplicate tag/);
    expect(p(repo({ journal: [{ idx: 0, tag: "0000_a", when: 5 }, { idx: 1, tag: "0001_b", when: 5 }] }))).toMatch(/strictly increasing/);
    expect(p(repo({ journal: [{ idx: 0, tag: "0000_a", when: 1 }, { idx: 2, tag: "0001_b", when: 2 }] }))).toMatch(/idx 2/);
    expect(p(repo({ files: { "0000_a.sql": "CREATE TABLE `alpha` (id int);" } }))).toMatch(/missing SQL for 0001_b/);
    expect(p(repo({ files: { "0000_a.sql": "CREATE TABLE `alpha` (id int);", "0001_b.sql": "CREATE TABLE `beta` (id int);", "0002_c.sql": "x" } }))).toMatch(/orphan migration file 0002_c.sql/);
    expect(p(repo({ schema: 'mysqlTable("alpha", {}); mysqlTable("gamma", {})' }))).toMatch(/schema table gamma/);
    expect(p(repo({ files: { "0000_a.sql": "CREATE TABLE `alpha` (id int);", "0001_b.sql": "CREATE TABLE `beta` (id int);", "0001_b.down.sql": "DROP TABLE beta;" } }))).toMatch(/down\/rollback artefact/);
    expect(p(repo({ journal: [{ idx: 0, tag: "0003_a", when: 1 }, { idx: 1, tag: "0001_b", when: 2 }] }))).toMatch(/does not match its position/);
  });
});

describe("capability truth", () => {
  const good = () => ({ vocabulary: { truthModel: ["PARTIAL"], status: ["TESTED_LOCAL"] }, capabilities: [{ capability: "x", truthModel: "PARTIAL", status: "TESTED_LOCAL", runtimePath: "a long enough path", sourceFiles: ["package.json"], tests: ["package.json"], workflowGate: ["pnpm test"], runtimeQualification: "RUNTIME_UNVERIFIED", ci: "CI_PENDING", knownLimitation: "a long enough limitation" }] });
  it("accepts the real map and refuses any unevidenced runtime or CI claim", () => {
    const real = checkCapabilityMap(readJson("SAKTHIAI_CAPABILITY_IMPLEMENTATION_MAP.json"), "."); expect(real.problems).toEqual([]); expect(real.runtimeVerified).toEqual([]); expect(real.total).toBeGreaterThan(20);
    expect(checkCapabilityMap(good(), ".").ok).toBe(true);
    const rt = good(); rt.capabilities[0].runtimeQualification = "RUNTIME_VERIFIED"; expect(checkCapabilityMap(rt, ".").problems.join()).toMatch(/RUNTIME_VERIFIED/);
    const ci = good(); ci.capabilities[0].ci = "CI_VERIFIED"; expect(checkCapabilityMap(ci, ".").problems.join()).toMatch(/CI status/);
    const missing = good(); missing.capabilities[0].sourceFiles = ["does/not/exist.ts"]; expect(checkCapabilityMap(missing, ".").problems.join()).toMatch(/does not exist/);
    const vocab = good(); vocab.capabilities[0].status = "DONE"; expect(checkCapabilityMap(vocab, ".").problems.join()).toMatch(/outside vocabulary/);
    expect(checkCapabilityMap({}, ".").ok).toBe(false);
  });
});

describe("report summarisers", () => {
  it("reads vitest / playwright / audit shapes and treats anything else as absent", () => {
    expect(summarizeVitest({ numTotalTests: 10, numPassedTests: 9, numFailedTests: 0, numPendingTests: 1, testResults: [{ status: "passed" }] })).toMatchObject({ present: true, total: 10, passed: 9, skipped: 1, files: 1 });
    expect(summarizeVitest({}).present).toBe(false); expect(summarizeVitest(null).present).toBe(false);
    expect(summarizePlaywright({ stats: { expected: 46, unexpected: 0, flaky: 0, skipped: 0 } })).toMatchObject({ present: true, expected: 46 }); expect(summarizePlaywright({}).present).toBe(false);
    expect(summarizeAudit({ metadata: { vulnerabilities: { low: 5, moderate: 24, high: 0, critical: 0 } } })).toMatchObject({ present: true, moderate: 24, high: 0 }); expect(summarizeAudit({}).present).toBe(false);
  });
});

function inputs(over: Partial<EvidenceInputs> = {}): EvidenceInputs {
  return {
    gitSha: "a".repeat(40), gitDirty: false, node: "v22", pnpm: "10.4.1", generatedAt: "2026-10-04T00:00:00.000Z",
    ci: { actions: false, upstreamJobsSucceeded: [] }, files: { lockfile: "l", packageJson: "p" },
    migrations: { ok: true, ids: ["0000_a", "0001_b"], problems: [], sqlDigest: "d" }, capability: { ok: true, total: 3, byTruthModel: { PARTIAL: 3 }, byStatus: { TESTED_LOCAL: 3 }, runtimeVerified: [], ciVerified: [], problems: [] },
    unit: { present: true, files: 5, filesFailed: 0, total: 100, passed: 99, failed: 0, skipped: 1 }, mysql: { present: true, files: 2, filesFailed: 0, total: 20, passed: 20, failed: 0, skipped: 0 },
    e2e: { present: true, expected: 46, unexpected: 0, flaky: 0, skipped: 0 }, audit: { present: true, info: 0, low: 5, moderate: 24, high: 0, critical: 0 },
    evalReport: { thresholds: { passed: true }, evidenceClass: "CONTRACT_HARNESS", realModelQuality: "NOT_MEASURED", aggregates: { cases: 28, casesPassed: 28 } },
    goldenReport: { thresholds: { passed: true }, evidenceClass: "CONTRACT_HARNESS_GOLDEN", realModelQuality: "REAL_MODEL_QUALITY_UNVERIFIED", corpusDigest: "c", aggregates: { scoredPassed: 38, scoredCases: 38, knownGapCases: 4 } },
    recoveryReport: { passed: true, managedDatabaseTouched: false, schemaDowngrade: "NOT_SUPPORTED_FORWARD_ONLY", engine: "MariaDB", evidenceClass: "LOCAL_REHEARSAL", scenarios: new Array(9).fill({}) },
    smoke: { ok: true, distPresent: true, healthz: 200, rootBytes: 571, readyz: 503 },
    evalDigest: "e", goldenDigest: "g", e2eDigest: "2", recoveryDigest: "r", secretHygiene: { ok: true, detail: "clean" }, sourceNeutrality: { ok: true, detail: "clean" },
    ...over,
  };
}
const ciRun = (extra: Partial<EvidenceInputs["ci"]> = {}) => ({ actions: true, runId: "1", runAttempt: "1", workflow: "SakthiAI Quality Gate", ref: "refs/pull/1/merge", sha: "a".repeat(40), upstreamJobsSucceeded: ["validate", "mysql-integration", "e2e"], ...extra });

describe("release evidence manifest", () => {
  it("a fully green LOCAL run is LOCAL_GATES_PASS_CI_PENDING: locally tested, never CI-verified, never runtime-verified", () => {
    const m = buildManifest(inputs());
    expect(m.summary).toMatchObject({ overall: "LOCAL_GATES_PASS_CI_PENDING", failed: [], missing: [] });
    expect(m.claims).toMatchObject({ SOURCE_IMPLEMENTED: true, LOCALLY_TESTED: true, CI_VERIFIED: false, CI_STATUS: "CI_PENDING", RUNTIME_VERIFIED: false, RUNTIME_STATUS: "RUNTIME_UNVERIFIED" });
    expect(m.environment.kind).toBe("LOCAL"); expect(m.gates.typecheck.status).toBe("NOT_ATTESTED"); expect(m.gates.frozenInstall.status).toBe("NOT_ATTESTED");
    expect(m.source.gitSha).toBe("a".repeat(40)); expect(m.migrations.latest).toBe("0001_b"); expect(m.evals.golden?.realModelQuality).toBe("REAL_MODEL_QUALITY_UNVERIFIED");
    expect(JSON.stringify(buildManifest(inputs()))).toBe(JSON.stringify(m)); // deterministic for equal inputs
  });
  it("inside GitHub Actions with attested upstream jobs, a clean tree and a matching SHA it is CI_GATES_PASS, and STILL not runtime-verified", () => {
    const m = buildManifest(inputs({ ci: ciRun() }));
    expect(m.summary.overall).toBe("CI_GATES_PASS"); expect(m.claims.CI_VERIFIED).toBe(true); expect(m.claims.RUNTIME_VERIFIED).toBe(false); expect(m.claims.RUNTIME_STATUS).toBe("RUNTIME_UNVERIFIED");
  });
  it("CI cannot be claimed with a dirty tree, a SHA mismatch, or without upstream job attestation", () => {
    expect(buildManifest(inputs({ ci: ciRun(), gitDirty: true })).claims.CI_VERIFIED).toBe(false);
    const mismatch = buildManifest(inputs({ ci: ciRun({ sha: "b".repeat(40) }) })); expect(mismatch.gates.ciShaBinding.status).toBe("FAIL"); expect(mismatch.summary.overall).toBe("GATES_FAILED"); expect(mismatch.claims.CI_VERIFIED).toBe(false);
    const partial = buildManifest(inputs({ ci: ciRun({ upstreamJobsSucceeded: ["validate"] }) })); expect(partial.claims.CI_VERIFIED).toBe(false); expect(partial.summary.overall).toBe("LOCAL_GATES_PASS_CI_PENDING");
    expect(buildManifest(inputs({ ci: ciRun({ upstreamJobsSucceeded: [] }) })).claims.CI_VERIFIED).toBe(false);
  });
  it("every failing or missing input fails or incompletes the manifest", () => {
    const cases: Array<[string, Partial<EvidenceInputs>, string, string]> = [
      ["unit failures", { unit: { present: true, files: 1, filesFailed: 1, total: 5, passed: 4, failed: 1, skipped: 0 } }, "unitTests", "GATES_FAILED"],
      ["zero unit tests", { unit: { present: true, files: 0, filesFailed: 0, total: 0, passed: 0, failed: 0, skipped: 0 } }, "unitTests", "GATES_FAILED"],
      ["unit missing", { unit: { present: false, files: 0, filesFailed: 0, total: 0, passed: 0, failed: 0, skipped: 0 } }, "unitTests", "GATES_INCOMPLETE"],
      ["mysql failures", { mysql: { present: true, files: 1, filesFailed: 0, total: 5, passed: 4, failed: 1, skipped: 0 } }, "mysqlIntegration", "GATES_FAILED"],
      ["e2e flaky", { e2e: { present: true, expected: 46, unexpected: 0, flaky: 1, skipped: 0 } }, "e2e", "GATES_FAILED"],
      ["e2e missing", { e2e: { present: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }, "e2e", "GATES_INCOMPLETE"],
      ["high advisory", { audit: { present: true, info: 0, low: 0, moderate: 0, high: 1, critical: 0 } }, "productionAdvisories", "GATES_FAILED"],
      ["critical advisory", { audit: { present: true, info: 0, low: 0, moderate: 0, high: 0, critical: 1 } }, "productionAdvisories", "GATES_FAILED"],
      ["audit missing", { audit: { present: false, info: 0, low: 0, moderate: 0, high: 0, critical: 0 } }, "productionAdvisories", "GATES_INCOMPLETE"],
      ["migration problem", { migrations: { ok: false, ids: [], problems: ["x"], sqlDigest: "" } }, "migrationConsistency", "GATES_FAILED"],
      ["capability problem", { capability: { ok: false, total: 1, byTruthModel: {}, byStatus: {}, runtimeVerified: ["x"], ciVerified: [], problems: ["x: claims RUNTIME_VERIFIED"] } }, "capabilityMap", "GATES_FAILED"],
      ["secret hygiene", { secretHygiene: { ok: false, detail: "leak" } }, "secretHygiene", "GATES_FAILED"],
      ["neutrality", { sourceNeutrality: { ok: false, detail: "coupling" } }, "sourceNeutrality", "GATES_FAILED"],
      ["smoke fails", { smoke: { ok: false, distPresent: true, detail: "x" } }, "builtServerSmoke", "GATES_FAILED"],
      ["dist missing", { smoke: { ok: false, distPresent: false } }, "build", "GATES_FAILED"],
      ["smoke missing", { smoke: null }, "builtServerSmoke", "GATES_INCOMPLETE"],
      ["eval overclaims real-model quality", { evalReport: { thresholds: { passed: true }, evidenceClass: "CONTRACT_HARNESS", realModelQuality: "MEASURED" } }, "evals", "GATES_FAILED"],
      ["eval missing", { evalReport: null }, "evals", "GATES_INCOMPLETE"],
      ["golden overclaims", { goldenReport: { thresholds: { passed: true }, evidenceClass: "CONTRACT_HARNESS_GOLDEN", realModelQuality: "REAL_MODEL_VERIFIED" } }, "goldenBenchmark", "GATES_FAILED"],
      ["golden merged with contract class", { goldenReport: { thresholds: { passed: true }, evidenceClass: "CONTRACT_HARNESS", realModelQuality: "REAL_MODEL_QUALITY_UNVERIFIED" } }, "goldenBenchmark", "GATES_FAILED"],
      ["recovery touched managed db", { recoveryReport: { passed: true, managedDatabaseTouched: true, schemaDowngrade: "NOT_SUPPORTED_FORWARD_ONLY" } }, "recoveryRehearsal", "GATES_FAILED"],
      ["recovery claims downgrade", { recoveryReport: { passed: true, managedDatabaseTouched: false, schemaDowngrade: "SUPPORTED" } }, "recoveryRehearsal", "GATES_FAILED"],
      ["recovery missing", { recoveryReport: null }, "recoveryRehearsal", "GATES_INCOMPLETE"],
    ];
    for (const [label, over, gate, overall] of cases) {
      const m = buildManifest(inputs(over)); expect(m.summary.overall, label).toBe(overall); expect([...m.summary.failed, ...m.summary.missing], label).toContain(gate);
      expect(m.claims.CI_VERIFIED, label).toBe(false); expect(m.claims.LOCALLY_TESTED, label).toBe(false); expect(m.claims.RUNTIME_VERIFIED, label).toBe(false);
    }
  });
});

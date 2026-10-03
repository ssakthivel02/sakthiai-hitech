import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { rankChunkCandidates } from "../../retrieval";
import { buildGoldenReport, loadCorpus, renderGoldenMarkdown, runCase, type GoldenCaseResult } from "./run";

const { corpus, digest } = loadCorpus();
const commit = (() => { try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } })();
const results = corpus.cases.map(c => runCase(corpus, c));
const report = buildGoldenReport(corpus, digest, results, { commit });

describe("golden Tamil / English / code-switch benchmark (CONTRACT_HARNESS_GOLDEN; real-model quality unverified)", () => {
  it("covers every required category and both languages with a non-trivial corpus", () => {
    const cats = new Set(corpus.cases.map(c => c.category));
    for (const required of ["tamil", "english", "code_switch", "transliterated", "grounded", "insufficient", "conflicting", "citation_selection", "ambiguous", "multi_document", "adversarial", "provider_unavailable", "embeddings_unavailable"]) expect(cats.has(required), required).toBe(true);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(corpus.cases.map(c => c.id)).size).toBe(corpus.cases.length);
    expect(report.byLanguage.ta.cases).toBeGreaterThan(10); expect(report.byLanguage.en.cases).toBeGreaterThan(10);
    expect(new Set(corpus.documents.map(d => d.workspaceId)).size).toBeGreaterThanOrEqual(2);
  });

  it("every scored case passes, thresholds hold and every documented gap still reproduces", () => {
    expect(report.thresholds.failures).toEqual([]);
    expect(report.thresholds.passed).toBe(true);
    expect(report.aggregates.crossWorkspaceLeaks).toBe(0);
    expect(report.knownGaps.length).toBeGreaterThanOrEqual(4);
    expect(report.knownGaps.every(g => g.reproduces)).toBe(true);
  });

  it("the report never claims real-model quality and never mixes with contract evals", () => {
    expect(report.realModelQuality).toBe("REAL_MODEL_QUALITY_UNVERIFIED");
    expect(report.evidenceClass).toBe("CONTRACT_HARNESS_GOLDEN");
    expect(report.paidProviderCalls).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/"evidenceClass":"CONTRACT_HARNESS"[,}]/);
  });

  it("is deterministic: two runs produce identical case results", () => {
    const again = corpus.cases.map(c => runCase(corpus, c));
    expect(JSON.stringify(again)).toBe(JSON.stringify(results));
  });

  it("the scorer detects regressions (a broken ranker, a tenant-leaking ranker and a stale gap are all caught)", () => {
    const broken = corpus.cases.map(c => runCase(corpus, c, () => [] as any));
    expect(buildGoldenReport(corpus, digest, broken).thresholds.passed).toBe(false);
    const leaky = corpus.cases.map(c => runCase({ ...corpus, documents: corpus.documents.map(d => ({ ...d, workspaceId: 1 })) }, { ...c, workspaceId: 1 }));
    expect(buildGoldenReport(corpus, digest, leaky).aggregates.crossWorkspaceLeaks).toBeGreaterThan(0);
    const matchEverything = corpus.cases.map(c => runCase(corpus, c, ((rows: any[]) => rows.map(({ chunk, document }) => ({ ...chunk, filename: document.filename, mimeType: document.mimeType, score: 1, retrievalMethod: "lexical" }))) as any));
    expect(buildGoldenReport(corpus, digest, matchEverything).thresholds.passed).toBe(false);
    // a gap that starts passing must be flagged so the corpus is updated
    const fakeStale: GoldenCaseResult[] = results.map(r => (r.knownGap ? { ...r, pass: true, failures: [] } : r));
    expect(buildGoldenReport(corpus, digest, fakeStale).thresholds.failures.join("\n")).toMatch(/now PASSES/);
    expect(typeof rankChunkCandidates).toBe("function");
  });

  it("writes the machine-readable and human reports", () => {
    const path = process.env.GOLDEN_REPORT_PATH ?? "reports/evals/golden-benchmark.json";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.replace(/\.json$/, ".md"), renderGoldenMarkdown(report));
    expect(report.aggregates.cases).toBe(corpus.cases.length);
  });
});

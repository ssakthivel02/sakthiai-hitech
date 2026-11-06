import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveGroundedOutcome, type GroundingState, type ModelResult } from "../../grounding";
import { rankChunkCandidates } from "../../retrieval";

/**
 * GOLDEN BENCHMARK (deterministic). Runs the REAL lexical/hybrid ranker and the REAL grounding resolver over a fixed
 * Tamil / English / code-switch / transliterated corpus. The "model" is a SCRIPTED reply per case, so this scores the
 * retrieval + grounding + citation CONTRACT of the pipeline. It says nothing about real-model answer quality:
 * the report carries `REAL_MODEL_QUALITY_UNVERIFIED` and is never merged with real-model results.
 */
export const GOLDEN_SCHEMA = "sakthiai.golden-benchmark/v1";
export const GOLDEN_EVIDENCE_CLASS = "CONTRACT_HARNESS_GOLDEN" as const;
export const REAL_MODEL_STATUS = "REAL_MODEL_QUALITY_UNVERIFIED" as const;
export const CORPUS_PATH = new URL("./corpus.json", import.meta.url);

const Grounding = z.enum(["GROUNDED_EVIDENCE", "INSUFFICIENT_EVIDENCE", "MODEL_UNAVAILABLE"]);
const Corpus = z.object({
  schema: z.literal("sakthiai.golden-corpus/v1"), note: z.string(),
  documents: z.array(z.object({ id: z.string(), workspaceId: z.number().int(), filename: z.string(), text: z.string(), vector: z.array(z.number()).optional() })).min(1),
  cases: z.array(z.object({
    id: z.string(), category: z.string(), workspaceId: z.number().int(), language: z.enum(["en", "ta"]), query: z.string(),
    embeddings: z.enum(["unavailable", "synthetic"]), queryVector: z.array(z.number()).optional(),
    retrieval: z.object({ mustInclude: z.array(z.string()).optional(), mustExclude: z.array(z.string()).optional(), topIs: z.string().optional(), none: z.boolean().optional(), maxResults: z.number().int().optional(), methods: z.array(z.enum(["lexical", "semantic", "hybrid"])).optional() }),
    model: z.discriminatedUnion("kind", [z.object({ kind: z.literal("answer"), text: z.string() }), z.object({ kind: z.literal("insufficient"), text: z.string() }), z.object({ kind: z.literal("empty") }), z.object({ kind: z.literal("failed") })]).optional(),
    grounding: Grounding.optional(), cited: z.array(z.string()).optional(), citationsOnlyFrom: z.array(z.string()).optional(),
    knownGap: z.object({ id: z.string(), description: z.string() }).optional(),
  })).min(1),
});
export type GoldenCorpus = z.infer<typeof Corpus>;
export type GoldenCase = GoldenCorpus["cases"][number];

export type GoldenCaseResult = {
  id: string; category: string; language: "en" | "ta"; embeddings: string; pass: boolean; knownGap: string | null; failures: string[];
  retrieved: string[]; grounding: GroundingState; citations: string[]; firstExpectedRank: number | null;
};
export type Ranker = typeof rankChunkCandidates;

export function loadCorpus(raw?: string): { corpus: GoldenCorpus; digest: string } {
  const text = raw ?? readFileSync(CORPUS_PATH, "utf8");
  return { corpus: Corpus.parse(JSON.parse(text)), digest: createHash("sha256").update(text).digest("hex") };
}

const modelOf = (c: GoldenCase): ModelResult => !c.model || c.model.kind === "failed" ? { status: "failed" } : c.model.kind === "empty" ? { status: "returned", content: "   " } : { status: "returned", content: c.model.text };

export function runCase(corpus: GoldenCorpus, c: GoldenCase, ranker: Ranker = rankChunkCandidates): GoldenCaseResult {
  const byChunkId = new Map<number, string>();
  // Same tenant filter db.searchChunks applies BEFORE ranking: only the caller's workspace is a candidate.
  const rows = corpus.documents.filter(d => d.workspaceId === c.workspaceId).map((d, i) => {
    byChunkId.set(i + 1, d.id);
    const synthetic = c.embeddings === "synthetic" && d.vector;
    return { chunk: { id: i + 1, content: d.text, embeddingJson: synthetic ? JSON.stringify(d.vector) : null, embeddingModel: synthetic ? "synthetic-test" : null }, document: { filename: d.filename, mimeType: "text/plain" } };
  });
  const queryVector = c.embeddings === "synthetic" ? c.queryVector ?? null : null;
  const ranked = ranker(rows, c.query, queryVector, 8, queryVector ? "synthetic-test" : null);
  const retrieved = ranked.map(r => byChunkId.get(r.id)!);
  const methods = ranked.map(r => r.retrievalMethod);
  // Chat path: no evidence -> INSUFFICIENT without calling a model; otherwise the (scripted) model result is resolved.
  const outcome = retrieved.length ? resolveGroundedOutcome({ language: c.language, evidenceCount: retrieved.length, model: modelOf(c) }) : { grounding: "INSUFFICIENT_EVIDENCE" as const, includeCitations: false };
  const citations = outcome.includeCitations ? retrieved : [];

  const failures: string[] = []; const r = c.retrieval;
  if (r.none && retrieved.length) failures.push(`expected no evidence, got [${retrieved.join(",")}]`);
  for (const id of r.mustInclude ?? []) if (!retrieved.includes(id)) failures.push(`missing evidence ${id}`);
  for (const id of r.mustExclude ?? []) if (retrieved.includes(id)) failures.push(`forbidden evidence ${id} retrieved`);
  if (r.topIs && retrieved[0] !== r.topIs) failures.push(`top result ${retrieved[0] ?? "none"} != ${r.topIs}`);
  if (r.maxResults !== undefined && retrieved.length > r.maxResults) failures.push(`too many results ${retrieved.length}`);
  if (r.methods) for (const id of r.mustInclude ?? []) { const m = methods[retrieved.indexOf(id)]; if (m && !r.methods.includes(m)) failures.push(`${id} retrieved via ${m}, expected ${r.methods.join("/")}`); }
  if (c.grounding && outcome.grounding !== c.grounding) failures.push(`grounding ${outcome.grounding} != ${c.grounding}`);
  if (c.cited) { for (const id of c.cited) if (!citations.includes(id)) failures.push(`expected citation ${id}`); }
  if (c.citationsOnlyFrom) for (const id of citations) if (!c.citationsOnlyFrom.includes(id)) failures.push(`unexpected citation ${id}`);
  if (!outcome.includeCitations && citations.length) failures.push("citations attached to a non-citing outcome");
  const expected = r.mustInclude ?? [];
  const rank = expected.length ? Math.min(...expected.map(id => retrieved.indexOf(id)).filter(i => i >= 0).map(i => i + 1), Infinity) : null;
  return { id: c.id, category: c.category, language: c.language, embeddings: c.embeddings, pass: failures.length === 0, knownGap: c.knownGap?.id ?? null, failures, retrieved, grounding: outcome.grounding, citations, firstExpectedRank: rank === Infinity ? null : rank };
}

const ratio = (n: number, d: number) => (d ? Number((n / d).toFixed(4)) : null);

export function buildGoldenReport(corpus: GoldenCorpus, digest: string, results: GoldenCaseResult[], meta: { commit?: string; generatedAt?: string } = {}) {
  const gapCases = results.filter(r => r.knownGap); const live = results.filter(r => !r.knownGap);
  const failures: string[] = [];
  for (const r of live) if (!r.pass) failures.push(`${r.id}: ${r.failures.join("; ")}`);
  // Drift guard: a documented gap that now passes means the corpus is stale (the gap was closed) and must be updated.
  for (const r of gapCases) if (r.pass) failures.push(`${r.id}: documented known gap ${r.knownGap} now PASSES; remove knownGap from the corpus`);
  const withExpected = live.filter(r => r.firstExpectedRank !== null || corpus.cases.find(c => c.id === r.id)?.retrieval.mustInclude?.length);
  const hits = withExpected.filter(r => r.firstExpectedRank !== null);
  const leaks = results.filter(r => r.failures.some(f => f.startsWith("forbidden evidence"))).length;
  const groundingChecked = live.filter(r => corpus.cases.find(c => c.id === r.id)?.grounding);
  const groundingOk = groundingChecked.filter(r => r.grounding === corpus.cases.find(c => c.id === r.id)!.grounding);
  const citeChecked = live.filter(r => corpus.cases.find(c => c.id === r.id)?.cited?.length);
  const citeOk = citeChecked.filter(r => corpus.cases.find(c => c.id === r.id)!.cited!.every(id => r.citations.includes(id)));
  const categories: Record<string, { cases: number; passed: number; knownGaps: number }> = {};
  const languages: Record<string, { cases: number; passed: number; knownGaps: number }> = {};
  for (const r of results) for (const [bucket, key] of [[categories, r.category], [languages, r.language]] as const) {
    const b = (bucket[key] ??= { cases: 0, passed: 0, knownGaps: 0 }); b.cases += 1; if (r.knownGap) b.knownGaps += 1; else if (r.pass) b.passed += 1;
  }
  const aggregates = {
    cases: results.length, scoredCases: live.length, scoredPassed: live.filter(r => r.pass).length, knownGapCases: gapCases.length,
    retrievalHitRate: ratio(hits.length, withExpected.length),
    meanReciprocalRank: withExpected.length ? Number((withExpected.reduce((s, r) => s + (r.firstExpectedRank ? 1 / r.firstExpectedRank : 0), 0) / withExpected.length).toFixed(4)) : null,
    groundingStateAccuracy: ratio(groundingOk.length, groundingChecked.length), citationRecall: ratio(citeOk.length, citeChecked.length), crossWorkspaceLeaks: leaks,
  };
  const thresholds = [
    ["all scored cases pass", aggregates.scoredPassed === aggregates.scoredCases], ["cross-workspace leaks == 0", aggregates.crossWorkspaceLeaks === 0],
    ["groundingStateAccuracy == 1", aggregates.groundingStateAccuracy === 1], ["citationRecall == 1", aggregates.citationRecall === 1], ["retrievalHitRate == 1", aggregates.retrievalHitRate === 1],
    ["known gaps still reproduce", gapCases.every(r => !r.pass)],
  ] as const;
  const failed = thresholds.filter(([, ok]) => !ok).map(([name]) => `threshold failed: ${name}`);
  return {
    schema: GOLDEN_SCHEMA, evidenceClass: GOLDEN_EVIDENCE_CLASS, realModelQuality: REAL_MODEL_STATUS,
    realModelNote: "The reply used per case is scripted. No model was called. Real-model answer quality for Tamil/English/code-switch has NOT been measured and must be reported in a separate real-model report, never merged into this one.",
    paidProviderCalls: 0, corpusSchema: "sakthiai.golden-corpus/v1", corpusNote: corpus.note, corpusDigest: digest,
    commit: meta.commit ?? "unknown", generatedAt: meta.generatedAt ?? new Date().toISOString(),
    aggregates, byCategory: categories, byLanguage: languages,
    knownGaps: gapCases.map(r => ({ case: r.id, gap: r.knownGap, description: corpus.cases.find(c => c.id === r.id)!.knownGap!.description, reproduces: !r.pass })),
    thresholds: { passed: failures.length === 0 && failed.length === 0, failures: [...failures, ...failed] },
    cases: results,
  };
}
export type GoldenReport = ReturnType<typeof buildGoldenReport>;

export function renderGoldenMarkdown(report: GoldenReport): string {
  const a = report.aggregates; const L: string[] = [];
  L.push("# SakthiAI Tamil / code-switch golden benchmark", "", `Evidence class: **${report.evidenceClass}** | Real-model quality: **${report.realModelQuality}** | Paid provider calls: ${report.paidProviderCalls}`, `Commit: ${report.commit} | Corpus digest: \`${report.corpusDigest.slice(0, 16)}\``, "",
    `Scored cases ${a.scoredPassed}/${a.scoredCases} passed; ${a.knownGapCases} documented known gaps (all reproduce). Retrieval hit rate ${a.retrievalHitRate}, MRR ${a.meanReciprocalRank}, grounding-state accuracy ${a.groundingStateAccuracy}, citation recall ${a.citationRecall}, cross-workspace leaks ${a.crossWorkspaceLeaks}.`, "",
    "This scores the retrieval/grounding/citation contract with scripted model replies. It does not measure real-model answer quality.", "", "| category | cases | passed | known gaps |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(report.byCategory)) L.push(`| ${k} | ${v.cases} | ${v.passed} | ${v.knownGaps} |`);
  L.push("", "## Known gaps (honest limitations, tracked not hidden)", "");
  for (const g of report.knownGaps) L.push(`- \`${g.case}\` - ${g.gap}: ${g.description}`);
  return L.join("\n") + "\n";
}

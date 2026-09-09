import fs from 'node:fs';
import path from 'node:path';

const outputPath = 'client/src/generated/intelligence-dashboard-data.json';
const ledgerPath = 'research/intelligence/gemini-two-month-ingestion-ledger.json';
const ragPath = 'research/document-rag/architecture-registry.json';
const evaluationPath = 'research/evaluation/benchmark-registry.json';
const videoQualityPath = 'research/evaluation/video-quality-spec.json';
const securityPath = 'research/security/threat-control-registry.json';

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing required intelligence source: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ledger = readJson(ledgerPath);
const rag = readJson(ragPath);
const evaluation = readJson(evaluationPath);
const videoQuality = readJson(videoQualityPath);
const security = readJson(securityPath);

const domainEvidence = {
  'SAI-03': 'Provider/model capability layer already governed under research/generative-media; video outputs now have a provider-neutral quality acceptance specification.',
  'SAI-04': 'Primary-source re-verification is required before any runtime provider binding.',
  'SAI-05': ledger.domains.find(domain => domain.id === 'SAI-05')?.sourceEvidence ?? 'Historical owner-supplied research checkpoint.',
  'SAI-06': `${rag.records?.length ?? 0} normalized architecture patterns; ${rag.sourceCheckpoint?.cumulativeCorpusCount ?? 'unknown'}-record source checkpoint.`,
  'SAI-07': 'Provider-independent voice architecture remains research evidence pending normalization.',
  'SAI-08': `${evaluation.sakthiaiOwnedSpecifications?.length ?? 0} SakthiAI-owned benchmark specifications plus ${videoQuality.sakthiaiAcceptanceDimensions?.length ?? 0} governed video-quality acceptance dimensions; ${evaluation.sourceCheckpoint?.nominalCumulativeCorpusCount ?? 'unknown'}-record nominal source checkpoint.`,
  'SAI-09': `${security.records?.length ?? 0} normalized defensive threat/control records; defensive-only policy enforced.`,
  'SAI-CF': 'Edge architecture intelligence remains research evidence; deployment changes stay gated.',
};

const dashboard = {
  schemaVersion: '1.0.0',
  generatedFrom: [ledgerPath, ragPath, evaluationPath, videoQualityPath, securityPath],
  source: {
    title: ledger.source?.title,
    pages: ledger.source?.pages,
    period: ledger.source?.period,
    status: ledger.source?.status,
    productionTruth: ledger.source?.productionTruth === true,
  },
  policy: {
    providerNeutral: ledger.policy?.providerNeutral === true,
    paidProviderActivationApproved: ledger.policy?.paidProviderActivation === true,
    productionApproved: ledger.policy?.productionApproval === true,
    primarySourceReverificationRequired: ledger.policy?.requirePrimarySourceReverificationBeforeRuntimeUse === true,
    newSchedulesCreated: ledger.policy?.newSchedulesCreated === true,
  },
  domains: (ledger.domains ?? []).map(domain => ({
    id: domain.id,
    name: domain.name,
    destination: domain.destination,
    surfaces: domain.surfaces ?? [],
    status: domain.status,
    use: domain.use,
    evidence: domainEvidence[domain.id] ?? 'Research evidence mapped to this domain.',
  })),
  registryMetrics: {
    documentRag: {
      normalizedRecords: rag.records?.length ?? 0,
      sourceCheckpoint: rag.sourceCheckpoint?.cumulativeCorpusCount ?? null,
      runtimeApproved: rag.runtimeApproved === true,
    },
    evaluation: {
      ownedSpecifications: evaluation.sakthiaiOwnedSpecifications?.length ?? 0,
      evaluationDimensions: evaluation.evaluationDimensions?.length ?? 0,
      sourceCheckpoint: evaluation.sourceCheckpoint?.nominalCumulativeCorpusCount ?? null,
      runtimeApproved: evaluation.runtimeApproved === true,
    },
    videoQuality: {
      stableId: videoQuality.stableId,
      acceptanceDimensions: videoQuality.sakthiaiAcceptanceDimensions?.length ?? 0,
      criticalDefects: videoQuality.criticalDefects?.length ?? 0,
      previewMinimumScore: videoQuality.acceptanceGates?.previewCandidate?.minimumWeightedScore ?? null,
      publishMinimumScore: videoQuality.acceptanceGates?.publishCandidate?.minimumWeightedScore ?? null,
      humanReviewRequiredForPublish: videoQuality.policy?.humanReviewRequiredForPublishCandidate === true,
      runtimeApproved: videoQuality.runtimeApproved === true,
    },
    security: {
      normalizedRecords: security.records?.length ?? 0,
      defensiveOnly: security.defensiveOnly === true,
      runtimeApproved: security.runtimeApproved === true,
    },
  },
};

const serialized = `${JSON.stringify(dashboard, null, 2)}\n`;
const mode = process.argv[2] ?? '--write';

if (mode === '--check') {
  if (!fs.existsSync(outputPath)) throw new Error(`Generated dashboard data missing: ${outputPath}`);
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Generated dashboard data is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (JSON.stringify(existing) !== JSON.stringify(dashboard)) {
    throw new Error(`Intelligence dashboard data is stale. Run: node ${process.argv[1]} --write`);
  }
  console.log(`INTELLIGENCE_DASHBOARD_DATA_PASS domains=${dashboard.domains.length}`);
} else if (mode === '--write') {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(`INTELLIGENCE_DASHBOARD_DATA_WRITTEN domains=${dashboard.domains.length}`);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}

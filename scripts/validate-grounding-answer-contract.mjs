import fs from "node:fs";

const contractPath = process.argv[2] || "release/grounding-answer-contract.json";
const routerPath = process.argv[3] || "server/routers.ts";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const source = fs.readFileSync(routerPath, "utf8");

const fail = message => {
  console.error(`GROUNDING_CONTRACT_FAIL: ${message}`);
  process.exit(1);
};

const requirements = contract.requirements || {};
if (requirements.noEvidenceAnswer !== "INSUFFICIENT_EVIDENCE") fail("no-evidence sentinel must remain exact");
if (contract.claims?.liveRagAcceptance !== false) fail("repository contract must not claim live RAG acceptance");
if (contract.claims?.hallucinationFree !== false) fail("repository contract must not claim hallucination-free operation");
if (contract.claims?.productionReady !== false) fail("repository contract must not claim production readiness");

const retrievalIndex = source.indexOf("const matches = await searchChunks");
const noEvidenceIndex = source.indexOf("if (!matches.length)");
const llmIndex = source.indexOf("await invokeLLM");

if (retrievalIndex < 0) fail("chat path must retrieve evidence before generation");
if (noEvidenceIndex < 0) fail("chat path must contain an explicit no-evidence branch");
if (llmIndex < 0) fail("LLM invocation anchor missing");
if (!(retrievalIndex < noEvidenceIndex && noEvidenceIndex < llmIndex)) {
  fail("no-evidence branch must execute after retrieval and before LLM invocation");
}

const noEvidenceWindow = source.slice(noEvidenceIndex, llmIndex);
if (!noEvidenceWindow.includes('const answer = "INSUFFICIENT_EVIDENCE"')) {
  fail("no-evidence branch must return the exact INSUFFICIENT_EVIDENCE sentinel");
}
if (!noEvidenceWindow.includes('citationsJson: "[]"')) {
  fail("no-evidence persistence must store an empty citation array");
}
if (!noEvidenceWindow.includes("citations: []")) {
  fail("no-evidence response must expose an empty citation array");
}
if (!noEvidenceWindow.includes('grounding: "INSUFFICIENT_EVIDENCE"')) {
  fail("no-evidence response must expose INSUFFICIENT_EVIDENCE grounding state");
}

if (!source.includes("Use only the supplied evidence")) fail("evidence-only system instruction is required");
if (!source.includes("If it does not support the answer, respond exactly INSUFFICIENT_EVIDENCE")) {
  fail("system instruction must require the exact insufficient-evidence sentinel");
}
if (!source.includes("Do not invent citations")) fail("system instruction must explicitly forbid invented citations");

console.log("GROUNDING_CONTRACT_PASS");

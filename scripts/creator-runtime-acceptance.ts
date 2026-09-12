import { verifyCreatorRuntimeAcceptance } from "../server/creator/runtimeAcceptance";

function printCheck(id: string, pass: boolean, detail: string) {
  const status = pass ? "PASS" : "FAIL";
  console.log(`${status} ${id}: ${detail}`);
}

async function main() {
  console.log("SakthiAI Creator runtime acceptance probe");
  console.log("Secrets are never printed by this script.");

  const acceptance = await verifyCreatorRuntimeAcceptance();
  for (const check of acceptance.checks) {
    printCheck(check.id, check.pass, check.detail);
  }

  if (!acceptance.readyForPaidGeneration) {
    console.error("BLOCKED: required Creator runtime acceptance checks are not all passing.");
    process.exitCode = 1;
    return;
  }

  console.log("PASS CREATOR_RUNTIME_ACCEPTANCE");
  console.log("Database schema and storage write/read were verified. No paid image/video generation was performed.");
  console.log("This evidence does not imply production approval or publication approval.");
}

main().catch(error => {
  console.error("FAIL CREATOR_RUNTIME_ACCEPTANCE:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

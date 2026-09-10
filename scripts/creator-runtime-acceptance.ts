import crypto from "node:crypto";
import { buildCreatorRuntimePreflight } from "../server/creator/runtimePreflight";
import { storagePut, storageRead } from "../server/storage";

function printCheck(id: string, pass: boolean, detail: string) {
  const status = pass ? "PASS" : "FAIL";
  console.log(`${status} ${id}: ${detail}`);
}

async function main() {
  const preflight = buildCreatorRuntimePreflight();

  console.log("SakthiAI Creator runtime acceptance probe");
  console.log("Secrets are never printed by this script.");

  for (const check of preflight.checks) {
    printCheck(check.id, check.pass, check.detail);
  }

  if (!preflight.readyForPaidGeneration) {
    console.error("BLOCKED: required runtime preflight checks are not all passing.");
    process.exitCode = 1;
    return;
  }

  const nonce = crypto.randomUUID();
  const payload = Buffer.from(`sakthiai-creator-storage-acceptance:${nonce}`, "utf8");
  const expectedSha256 = crypto.createHash("sha256").update(payload).digest("hex");

  try {
    const written = await storagePut(
      `creator/acceptance/runtime-${Date.now()}.txt`,
      payload,
      "text/plain; charset=utf-8",
    );
    const readBack = Buffer.from(await storageRead(written.key));
    const actualSha256 = crypto.createHash("sha256").update(readBack).digest("hex");
    const matches = payload.equals(readBack) && expectedSha256 === actualSha256;

    printCheck(
      "STORAGE_WRITE_READ_ACCEPTANCE",
      matches,
      matches
        ? `Round-trip succeeded; key=${written.key}; sha256=${actualSha256}`
        : "Round-trip content/checksum mismatch.",
    );

    if (!matches) {
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    printCheck(
      "STORAGE_WRITE_READ_ACCEPTANCE",
      false,
      error instanceof Error ? error.message : "Unknown storage acceptance failure.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("PASS CREATOR_RUNTIME_ACCEPTANCE_STRUCTURAL");
  console.log("This does not perform paid image/video generation and does not imply production approval.");
}

main().catch(error => {
  console.error("FAIL CREATOR_RUNTIME_ACCEPTANCE_STRUCTURAL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

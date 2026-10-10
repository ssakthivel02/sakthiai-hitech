import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const router = readFileSync(path.join(root, "server/routers.ts"), "utf8");
const prompt = readFileSync(path.join(root, "server/chat/grounded.ts"), "utf8");
const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function validate(routerSource = router, promptSource = prompt) {
  const dir = mkdtempSync(path.join(tmpdir(), "grounding-validator-"));
  temporary.push(dir);
  const routerFile = path.join(dir, "routers.ts");
  const promptFile = path.join(dir, "grounded.ts");
  writeFileSync(routerFile, routerSource);
  writeFileSync(promptFile, promptSource);
  return spawnSync(process.execPath, ["scripts/validate-grounding-answer-contract.mjs", "release/grounding-answer-contract.json", routerFile, "server/grounding.ts", promptFile], { cwd: root, encoding: "utf8" });
}

describe("grounding contract validator after shared-prompt extraction", () => {
  it("accepts the real chat path and shared prompt", () => {
    const result = validate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GROUNDING_CONTRACT_PASS");
  });

  it.each([
    "Use only the supplied evidence",
    "If it does not support the answer, respond exactly INSUFFICIENT_EVIDENCE",
    "Do not invent citations",
  ])("rejects removal of the shared prompt rule: %s", rule => {
    const result = validate(router, prompt.replace(rule, ""));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GROUNDING_CONTRACT_FAIL");
  });

  it("rejects a chat path that bypasses the shared prompt", () => {
    const result = validate(router.replace("content: groundedSystemPrompt(input.language, matches)", 'content: "Answer freely"'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must pass the shared evidence prompt");
  });

  it("rejects a missing shared-prompt import", () => {
    const result = validate(router.replace('import { toCitations, groundedSystemPrompt } from "./chat/grounded";', 'import { toCitations } from "./chat/grounded";'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must import the shared groundedSystemPrompt");
  });
});

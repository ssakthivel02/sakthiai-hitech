import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Capability = { capability: string; truthModel: string; status: string; runtimePath: string; sourceFiles: string[]; tests: string[]; workflowGate: string[]; runtimeQualification: string; ci: string; knownLimitation: string };
const map = JSON.parse(readFileSync("SAKTHIAI_CAPABILITY_IMPLEMENTATION_MAP.json", "utf8")) as { vocabulary: { status: string[]; truthModel: string[] }; capabilities: Capability[] };
const REQUIRED = ["authentication", "session_revocation", "tenant_isolation", "storage_authorization", "file_ingestion", "malware_gate", "english_lexical_retrieval", "tamil_lexical_retrieval", "semantic_retrieval", "grounded_response", "model_unavailable_truthfulness", "capability_router", "provider_gateway", "local_self_host_path", "external_provider_path", "budget_controls", "creator_provider_path", "readiness_liveness"];

describe("SAKTHIAI_CAPABILITY_IMPLEMENTATION_MAP.json truth contract", () => {
  it("covers every required capability exactly once", () => {
    const ids = map.capabilities.map(c => c.capability);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of REQUIRED) expect(ids, id).toContain(id);
  });
  it("uses only the declared vocabulary and has every field populated", () => {
    for (const c of map.capabilities) {
      expect(map.vocabulary.status, c.capability).toContain(c.status);
      expect(map.vocabulary.truthModel, c.capability).toContain(c.truthModel);
      expect(c.runtimePath.length, c.capability).toBeGreaterThan(5);
      expect(c.knownLimitation.length, c.capability).toBeGreaterThan(10);
      expect(c.sourceFiles.length, c.capability).toBeGreaterThan(0);
      expect(c.tests.length, c.capability).toBeGreaterThan(0);
      expect(c.workflowGate.length, c.capability).toBeGreaterThan(0);
    }
  });
  it("every referenced source file, test and workflow exists", () => {
    for (const c of map.capabilities) {
      for (const file of [...c.sourceFiles, ...c.tests]) expect(existsSync(file), `${c.capability}: ${file}`).toBe(true);
      for (const gate of c.workflowGate) if (gate.startsWith(".github/") || gate.startsWith("scripts/")) expect(existsSync(gate), `${c.capability}: ${gate}`).toBe(true);
    }
  });
  it("never claims runtime or CI verification without evidence", () => {
    for (const c of map.capabilities) {
      expect(c.status, c.capability).not.toBe("RUNTIME_VERIFIED");
      expect(c.runtimeQualification, c.capability).toBe("RUNTIME_UNVERIFIED");
      expect(c.ci, c.capability).toBe("CI_PENDING");
      // a unit/contract-tested capability can never be DESIGN_ONLY/MISSING, nor IMPLEMENTED when it is knowingly partial
      if (/not (live )?qualified|no real|not exercised|in-memory/i.test(c.knownLimitation)) expect(["PARTIAL", "IMPLEMENTED"], c.capability).toContain(c.truthModel);
    }
  });
  it("capabilities whose known limitation says live verification is absent are not marked IMPLEMENTED-and-verified", () => {
    for (const id of ["semantic_retrieval", "local_self_host_path", "external_provider_path", "malware_gate"]) {
      expect(map.capabilities.find(c => c.capability === id)!.truthModel, id).toBe("PARTIAL");
    }
  });
});

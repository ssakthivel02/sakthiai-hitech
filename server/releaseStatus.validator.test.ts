import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Exercise the actual CLI: source/CI evidence must never masquerade as runtime GO. */
const root = process.cwd();
const originalLedger = JSON.parse(readFileSync(resolve(root, "release/release-status.json"), "utf8"));
const originalContract = JSON.parse(readFileSync(resolve(root, "release/beta-capability-contract.json"), "utf8"));
const previewLayers = ["preview-deploy", "preview-database", "session-isolation", "build-identity"];

function check(ledger: any, contract: any = originalContract): boolean {
  const dir = mkdtempSync(join(tmpdir(), "sakthiai-go-gate-"));
  try {
    const ledgerFile = join(dir, "ledger.json");
    const contractFile = join(dir, "contract.json");
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    writeFileSync(contractFile, JSON.stringify(contract));
    const run = spawnSync(process.execPath, [resolve(root, "scripts/validate-release-status.mjs"), ledgerFile, contractFile], {
      cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    if (run.error) throw run.error;
    return run.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function syntheticPreviewGo(): any {
  const ledger = structuredClone(originalLedger);
  const now = new Date().toISOString();
  ledger.observedAt = now;
  ledger.deployment.observedAt = now;
  ledger.deployment.observedCommit = ledger.candidate.lastCiVerifiedCommit;
  ledger.verdicts.preview = "go";
  // Synthetic schema fixture only. No hosted runtime or owner approval is asserted.
  for (const layer of ledger.layers) {
    layer.state = "ci_passed";
    delete layer.blocker;
    delete layer.verifiedAt;
    if (previewLayers.includes(layer.id)) {
      layer.state = "live_verified";
      layer.verifiedAt = now;
    }
  }
  return ledger;
}

describe("public release GO verdict validator CLI", () => {
  it("accepts the actual committed NO-GO ledger", () => {
    expect(check(originalLedger)).toBe(true);
  });

  it("rejects CI-only GO with zero live-verified layers", () => {
    const ledger = syntheticPreviewGo();
    for (const layer of ledger.layers) {
      layer.state = "ci_passed";
      delete layer.verifiedAt;
    }
    expect(check(ledger)).toBe(false);
  });

  it.each(previewLayers)("rejects preview GO without %s runtime evidence", id => {
    const ledger = syntheticPreviewGo();
    const layer = ledger.layers.find((item: any) => item.id === id);
    layer.state = "ci_passed";
    delete layer.verifiedAt;
    expect(check(ledger)).toBe(false);
  });

  it("rejects GO with a separately blocked layer", () => {
    const ledger = syntheticPreviewGo();
    const scanner = ledger.layers.find((item: any) => item.id === "file-scanner");
    scanner.state = "blocked";
    scanner.blocker = "Live malware scanning has not yet been qualified";
    expect(check(ledger)).toBe(false);
  });

  it("rejects stale ledger evidence", () => {
    const ledger = syntheticPreviewGo();
    ledger.observedAt = "2026-01-01T00:00:00Z";
    expect(check(ledger)).toBe(false);
  });

  it("rejects stale deployment evidence", () => {
    const ledger = syntheticPreviewGo();
    ledger.deployment.observedAt = "2026-01-01T00:00:00Z";
    expect(check(ledger)).toBe(false);
  });

  it("rejects a different deployed commit even when other evidence looks healthy", () => {
    const ledger = syntheticPreviewGo();
    ledger.deployment.observedCommit = "469c668e71ceaae800e8605c5814e7017035fdbc";
    expect(check(ledger)).toBe(false);
  });

  it("rejects stale per-layer verification", () => {
    const ledger = syntheticPreviewGo();
    ledger.layers.find((item: any) => item.id === "session-isolation").verifiedAt = "2026-01-01T00:00:00Z";
    expect(check(ledger)).toBe(false);
  });

  it("accepts a fully populated synthetic preview proof shape", () => {
    expect(check(syntheticPreviewGo())).toBe(true);
  });

  it("rejects production GO without explicit contract approval", () => {
    const ledger = syntheticPreviewGo();
    ledger.verdicts.production = "go";
    const production = ledger.layers.find((item: any) => item.id === "production-environment");
    production.state = "live_verified";
    production.verifiedAt = new Date().toISOString();
    expect(check(ledger)).toBe(false);
  });

  it("rejects production GO while the preview verdict is NO-GO", () => {
    const ledger = syntheticPreviewGo();
    ledger.verdicts.preview = "no-go";
    ledger.verdicts.production = "go";
    expect(check(ledger, { ...originalContract, productionApproved: true })).toBe(false);
  });

  it("rejects production GO without a live production environment", () => {
    const ledger = syntheticPreviewGo();
    ledger.verdicts.production = "go";
    expect(check(ledger, { ...originalContract, productionApproved: true })).toBe(false);
  });

  it("accepts a complete synthetic production proof shape with contract approval", () => {
    const ledger = syntheticPreviewGo();
    ledger.verdicts.production = "go";
    const production = ledger.layers.find((item: any) => item.id === "production-environment");
    production.state = "live_verified";
    production.verifiedAt = new Date().toISOString();
    expect(check(ledger, { ...originalContract, productionApproved: true })).toBe(true);
  });
});

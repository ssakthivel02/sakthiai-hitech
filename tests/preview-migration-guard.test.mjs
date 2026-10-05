import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECOVERY_EVIDENCE_CLASS, checkJournal, compareSnapshots, expectedJournal, parseRecoveryPoint, runGuard } from "../scripts/preview-migration-guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const NOW = new Date("2026-10-05T01:00:00Z");
const journal = expectedJournal(root);
const applied = n => journal.slice(0, n).map((e, i) => ({ id: i + 1, hash: e.hash, created_at: e.when }));

describe("preview migration guard: owner-attested recovery point", () => {
  it.each(["2026-10-02T07:58:07.224822Z", "2026-10-05T00:10Z", "2026-10-05T00:10:00Z", "2024-02-29T23:59:59Z"])("accepts the real UTC instant %s", text => {
    const r = parseRecoveryPoint(text, NOW);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["2026-02-30T10:00:00Z", /not a real/], ["2026-13-01T00:00Z", /not a real/], ["2026-10-05T24:00Z", /not a real/], ["2026-10-05T10:60Z", /not a real/],
    ["2025-02-29T00:00Z", /not a real/], ["2026-10-04T23:59:60Z", /not a real/],
    ["2026-10-05 00:10", /UTC timestamp/], ["2026-10-05T00:10", /UTC timestamp/], ["2026-10-05T00:10+05:30", /UTC timestamp/], ["yesterday", /UTC timestamp/], ["", /UTC timestamp/], [undefined, /UTC timestamp/],
    ["2026-10-05T02:00:00Z", /future/],
  ])("rejects %s", (text, reason) => {
    const r = parseRecoveryPoint(text, NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(reason);
  });

  it("records a typed timestamp as owner-attested evidence, never as a verified backup", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-attest-"));
    const { problems, report } = await runGuard("attest", { recoveryPoint: "2026-10-02T07:58:07Z", now: NOW, reportDir: dir });
    rmSync(dir, { recursive: true, force: true });
    expect(problems).toEqual([]);
    expect(report.recoveryEvidence).toEqual({ class: RECOVERY_EVIDENCE_CLASS, attestedRecoveryPoint: "2026-10-02T07:58:07.000Z", providerVerified: false });
    expect(RECOVERY_EVIDENCE_CLASS).toBe("OWNER_ATTESTED");
    expect(readFileSync(path.join(root, "scripts/preview-migration-guard.mjs"), "utf8")).not.toMatch(/BACKUP_VERIFIED/);
  });
});

describe("preview migration guard: journal matches the Drizzle migrator format", () => {
  it("expected hashes are sha256 of each drizzle/<tag>.sql and created_at is the journal `when`", () => {
    expect(journal.length).toBeGreaterThanOrEqual(11);
    for (const e of journal) { expect(e.hash).toMatch(/^[0-9a-f]{64}$/); expect(Number.isInteger(e.when)).toBe(true); }
    expect(new Set(journal.map(e => e.hash)).size).toBe(journal.length);
  });

  it("accepts an exact in-order prefix and, when complete, only the full journal", () => {
    expect(checkJournal(applied(5), journal)).toEqual([]);
    expect(checkJournal([], journal)).toEqual([]);
    expect(checkJournal(applied(journal.length), journal, { complete: true })).toEqual([]);
    expect(checkJournal(applied(5), journal, { complete: true }).join()).toMatch(/expected \d+ applied migrations, found 5/);
  });

  it("rejects an applied migration whose hash differs from the repository SQL", () => {
    const rows = applied(5); rows[2] = { ...rows[2], hash: "0".repeat(64) };
    expect(checkJournal(rows, journal).join()).toMatch(/#3 \(0002_semantic_rag_provenance\) hash .* does not match/);
  });

  it("rejects unexpected journal state: wrong timestamp, out-of-order rows and more rows than the journal", () => {
    const shifted = applied(5); shifted[1] = { ...shifted[1], created_at: shifted[1].created_at + 1 };
    expect(checkJournal(shifted, journal).join()).toMatch(/#2 has created_at/);
    const swapped = applied(5); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    expect(checkJournal(swapped, journal).length).toBeGreaterThanOrEqual(2);
    const extra = [...applied(journal.length), { id: 99, hash: "f".repeat(64), created_at: 9_999_999_999_999 }];
    expect(checkJournal(extra, journal).join()).toMatch(/but the journal has only/);
  });
});

describe("preview migration guard: rerun must be an exact no-op", () => {
  const base = { journal: applied(3), tables: ["a", "b"], columns: ["a.id int"], indexes: ["a.PRIMARY#1=id unique=true"], constraints: ["a.PRIMARY PRIMARY KEY id"], counts: { a: 1, b: 0 } };
  it("passes only when journal, schema and row counts are identical", () => {
    expect(compareSnapshots(base, structuredClone(base))).toEqual([]);
    expect(compareSnapshots(base, { ...base, indexes: [...base.indexes, "a.x#1=y unique=false"] })).toEqual(["indexes changed during the claimed no-op rerun"]);
    expect(compareSnapshots(base, { ...base, counts: { a: 2, b: 0 } })).toEqual(["counts changed during the claimed no-op rerun"]);
    expect(compareSnapshots(base, { ...base, journal: applied(4) })).toEqual(["journal changed during the claimed no-op rerun"]);
  });
});

describe("preview-db-setup.yml wiring", () => {
  const wf = readFileSync(path.join(root, ".github/workflows/preview-db-setup.yml"), "utf8");
  it("validates the attested recovery point with the guard and checks the second db:push against the post snapshot", () => {
    expect(wf).toMatch(/recovery_point:[\s\S]*required: true/);
    expect(wf).toMatch(/RECOVERY_POINT: \$\{\{ inputs\.recovery_point \}\}\n\s+run: node scripts\/preview-migration-guard\.mjs attest/);
    expect(wf).toMatch(/RECOVERY_POINT: \$\{\{ inputs\.recovery_point \}\}\n\s+run: node scripts\/preview-migration-guard\.mjs pre/);
    expect(wf).toMatch(/pnpm db:push\n\s+node scripts\/preview-migration-guard\.mjs rerun/);
    expect(wf.indexOf("guard.mjs pre")).toBeLessThan(wf.indexOf("Apply preview schema"));
    expect(wf).not.toMatch(/=~ \^20\[0-9\]/);
  });

  it("defaults to a read-only inspect mode; every database-writing step runs only with mode=migrate", () => {
    expect(wf).toMatch(/mode:[\s\S]*type: choice[\s\S]*options: \[inspect, migrate\][\s\S]*default: inspect/);
    const steps = wf.split(/\n      - name: /).slice(1);
    const writers = steps.filter(step => /pnpm db:push|db:backfill-search-text/.test(step));
    expect(writers.length).toBe(3);
    for (const step of writers) expect(step).toMatch(/\n        if: inputs\.mode == 'migrate'\n/);
    const post = steps.find(step => step.startsWith("Post-migration"));
    expect(post).toMatch(/if: inputs\.mode == 'migrate'/);
    for (const step of steps.filter(step => /guard\.mjs (attest|pre)\b/.test(step))) expect(step).not.toMatch(/if: inputs\.mode/);
  });
});

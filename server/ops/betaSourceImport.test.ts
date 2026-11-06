import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmationToken, ImportRefusal, loadCorpus, MAX_DOCUMENT_BYTES, SYNTHETIC_MARKER } from "./betaSourceImport";

const REAL = path.resolve(process.cwd(), "release/beta-sources");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function copyCorpus() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "beta-corpus-"));
  cpSync(REAL, dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  return { dir, manifestPath, manifest: () => JSON.parse(readFileSync(manifestPath, "utf8")), save: (m: unknown) => writeFileSync(manifestPath, JSON.stringify(m)) };
}
async function reasonsFor(dir: string): Promise<string[]> {
  try { await loadCorpus(dir); } catch (error) { if (error instanceof ImportRefusal) return error.reasons.length ? error.reasons : [error.message]; throw error; }
  return [];
}

describe("approved synthetic beta corpus (release/beta-sources)", () => {
  it("loads, is hash-pinned, bilingual, and entirely marked synthetic", async () => {
    const corpus = await loadCorpus(REAL);
    expect(corpus.corpusId).toBe("sakthiai-beta-synthetic-v1");
    expect(corpus.documents.length).toBeGreaterThanOrEqual(6);
    expect(new Set(corpus.documents.map(d => d.language))).toEqual(new Set(["en", "ta"]));
    for (const doc of corpus.documents) {
      expect(sha(doc.bytes)).toBe(doc.sha256);
      expect(doc.bytes.toString("utf8").startsWith(SYNTHETIC_MARKER)).toBe(true);
      expect(doc.bytes.length).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    }
  });

  it("is not the golden eval corpus or the Q8 prompt set (no reuse of examined prompts as sources)", async () => {
    const golden = readFileSync(path.resolve(process.cwd(), "server/evals/golden/corpus.json"), "utf8");
    const corpus = await loadCorpus(REAL);
    for (const doc of corpus.documents) {
      const body = doc.bytes.toString("utf8").split("\n").slice(2).join("\n").trim();
      expect(golden.includes(body)).toBe(false);
    }
  });

  it("rejects a file whose bytes differ from the manifest hash", async () => {
    const c = copyCorpus(); const m = c.manifest();
    writeFileSync(path.join(c.dir, m.documents[0].file), `${SYNTHETIC_MARKER}\n\nTampered.`);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/sha256 does not match/);
  });

  it("rejects a document that lacks the SYNTHETIC marker even when its hash is pinned", async () => {
    const c = copyCorpus(); const m = c.manifest(); const body = Buffer.from("Real looking text without a marker.");
    writeFileSync(path.join(c.dir, m.documents[0].file), body); m.documents[0].sha256 = sha(body); c.save(m);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/missing SYNTHETIC marker/);
  });

  it("rejects a manifest that does not declare synthetic:true", async () => {
    const c = copyCorpus(); const m = c.manifest(); m.synthetic = false; c.save(m);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/synthetic:true/);
  });

  it("rejects path traversal and non-synthetic file names", async () => {
    const c = copyCorpus(); const m = c.manifest();
    m.documents[0].file = "../secret.txt"; m.documents[0].filename = "../secret.txt"; c.save(m);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/synthetic-\*\.txt/);
    const d = copyCorpus(); const n = d.manifest(); n.documents[0].file = "customers.txt"; n.documents[0].filename = "customers.txt"; d.save(n);
    expect((await reasonsFor(d.dir)).join(" ")).toMatch(/synthetic-\*\.txt/);
  });

  it("rejects a language that does not match the text", async () => {
    const c = copyCorpus(); const m = c.manifest(); const ta = m.documents.find((d: { language: string }) => d.language === "ta"); ta.language = "en"; c.save(m);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/declared English but contains Tamil/);
  });

  it("rejects an oversize document and a duplicate entry", async () => {
    const c = copyCorpus(); const m = c.manifest(); const big = Buffer.from(`${SYNTHETIC_MARKER}\n\n${"a ".repeat(MAX_DOCUMENT_BYTES)}`);
    writeFileSync(path.join(c.dir, m.documents[0].file), big); m.documents[0].sha256 = sha(big); c.save(m);
    expect((await reasonsFor(c.dir)).join(" ")).toMatch(/size out of bounds/);
    const d = copyCorpus(); const n = d.manifest(); n.documents.push({ ...n.documents[0] }); d.save(n);
    expect((await reasonsFor(d.dir)).join(" ")).toMatch(/duplicate document/);
  });
});

describe("confirmation token", () => {
  const corpus = { corpusId: "c-1", manifestSha256: "a".repeat(64) };
  it("is stable, order-insensitive and bound to corpus, workspaces and database", () => {
    const base = confirmationToken(corpus, [3, 4], "beta_db");
    expect(base).toMatch(/^IMPORT-[0-9A-F]{16}$/);
    expect(confirmationToken(corpus, [4, 3, 3], "beta_db")).toBe(base);
    expect(confirmationToken(corpus, [3], "beta_db")).not.toBe(base);
    expect(confirmationToken(corpus, [3, 4], "other_db")).not.toBe(base);
    expect(confirmationToken({ ...corpus, manifestSha256: "b".repeat(64) }, [3, 4], "beta_db")).not.toBe(base);
  });
});

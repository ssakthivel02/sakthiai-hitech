// Static contract for drizzle/meta/_journal.json. The drizzle-orm MySQL migrator applies a migration only when its
// journal `when` is strictly greater than the last applied __drizzle_migrations.created_at, so two entries sharing a
// `when` (the PR #29 / Artifacts 0013 collision) or a non-increasing sequence silently skips DDL on upgraded databases.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
const sha256 = file => createHash("sha256").update(readFileSync(path.join(root, "drizzle", file)).toString()).digest("hex");

// Applied-history anchors: a database that already ran one of these records exactly this hash at this position.
// Changing either file (or its slot) makes the migration guard refuse every database that applied it.
const PINNED = {
  "0013_rate_limit_windows": { idx: 13, when: 1790726400000, sha256: "a5c2560bcd5e98e320af0770fc7ca5a2a2ff26854a5d60d4a25a5df2f7e7ae13" },
  "0014_workspace_artifacts": { idx: 14, sha256: "256bd255254ecdd7cb150051bd05936bac061f18b37b05d889c58466485679d3" },
};

describe("drizzle migration journal ordering", () => {
  it("idx is contiguous from 0 and every tag's numeric prefix equals its idx", () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      expect(Number(e.tag.slice(0, 4)), e.tag).toBe(i);
    });
  });

  it("tags and numeric prefixes are unique (no two migrations claim one slot)", () => {
    const prefixes = journal.entries.map(e => e.tag.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(journal.entries.map(e => e.tag)).size).toBe(journal.entries.length);
  });

  it("`when` is strictly increasing, so the migrator never skips a later migration", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when, `${journal.entries[i].tag} after ${journal.entries[i - 1].tag}`).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it("the journal and drizzle/*.sql are the same set (no orphan or missing SQL)", () => {
    const sql = readdirSync(path.join(root, "drizzle")).filter(f => f.endsWith(".sql")).map(f => f.replace(/\.sql$/, "")).sort();
    expect(sql).toEqual(journal.entries.map(e => e.tag).sort());
  });

  it("0013_rate_limit_windows is preserved unchanged and the artifacts migration follows it as 0014", () => {
    for (const [tag, pin] of Object.entries(PINNED)) {
      const entry = journal.entries.find(e => e.tag === tag);
      expect(entry, tag).toBeDefined();
      expect(entry.idx, tag).toBe(pin.idx);
      if (pin.when) expect(entry.when, tag).toBe(pin.when);
      expect(sha256(`${tag}.sql`), tag).toBe(pin.sha256);
    }
    expect(journal.entries.some(e => e.tag === "0013_workspace_artifacts")).toBe(false);
  });
});

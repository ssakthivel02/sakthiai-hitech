import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
  return out;
}
const root = process.cwd();
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

describe("synthetic-source import is operator-only (no public ingestion surface)", () => {
  it("is imported by nothing in server/ or client/ except its own tests", () => {
    const offenders = [...walk(path.join(root, "server")), ...walk(path.join(root, "client/src")), ...walk(path.join(root, "shared"))]
      .filter(f => !rel(f).startsWith("server/ops/"))
      .filter(f => /betaSourceImport/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("is referenced only by the CLI under scripts/", () => {
    const users = walk(path.join(root, "scripts")).filter(f => /betaSourceImport/.test(readFileSync(f, "utf8"))).map(rel);
    expect(users).toEqual(["scripts/import-beta-sources.ts"]);
  });

  it("the module registers no route or procedure", () => {
    const source = readFileSync(path.join(root, "server/ops/betaSourceImport.ts"), "utf8");
    expect(source).not.toMatch(/protectedProcedure|publicProcedure|router\(|app\.(get|post|use)|express/);
    expect(source).not.toMatch(/\bfetch\(|https?:\/\/|storagePut|tryEmbed/);
  });

  it("the CLI is dry-run by default and refuses to apply without the confirmation and database flags", () => {
    const cli = readFileSync(path.join(root, "scripts/import-beta-sources.ts"), "utf8");
    expect(cli).toMatch(/if \(!args\.apply\)/);
    expect(cli).toMatch(/--expect-database/);
    expect(cli).toMatch(/loginAccessPolicy\(process\.env, true\)/);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RECOVERY_EVIDENCE_CLASS, checkJournal, checkPrincipalGrants, classifySchema, compareSnapshots, expectedJournal, migrationObjects, parseRecoveryPoint, recoveryUncoveredTables, runGuard } from "../scripts/preview-migration-guard.mjs";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";

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

  it("serialises runs and lets a failed guard stop the job before any database write", () => {
    expect(wf).toMatch(/\nconcurrency:\n\s+group: sakthiai-preview-db\n\s+cancel-in-progress: false\n/);
    expect(wf).not.toMatch(/continue-on-error/);
    const steps = wf.split(/\n      - name: /).slice(1);
    // only the evidence upload may run after a failure, and it never touches the database
    for (const step of steps.filter(step => /if: always\(\)|if: failure\(\)/.test(step))) expect(step).toMatch(/^Upload preview migration evidence/);
    expect(wf.indexOf("guard.mjs attest")).toBeLessThan(wf.indexOf("guard.mjs pre"));
  });
});

describe("schema classification against the journal (no database)", () => {
  // resolved in beforeAll, not at collection time: a parser failure must fail these tests, not the whole file
  let objects = [];
  beforeAll(() => { objects = migrationObjects(root); });
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));

  it("parses every object the additive migrations create, matching the SQL and the app's Drizzle schema", () => {
    expect(objects.map(o => o.tag)).toEqual(journal.entries.map(e => e.tag));
    for (const o of objects) {
      const sql = readFileSync(path.join(root, "drizzle", `${o.tag}.sql`), "utf8");
      expect(o.tables.length, o.tag).toBe((sql.match(/CREATE TABLE/gi) ?? []).length);
      expect(o.indexes.length, o.tag).toBe((sql.match(/CREATE (UNIQUE )?INDEX|CONSTRAINT `[^`]+` (PRIMARY KEY|UNIQUE)/gi) ?? []).length);
      expect(sql, o.tag).not.toMatch(/\b(DROP|RENAME)\b/i);
    }
    // the drizzle schema (what /readyz expects) declares exactly these tables and columns
    const schemaTs = readFileSync(path.join(root, "drizzle/schema.ts"), "utf8");
    const declaredTables = [...schemaTs.matchAll(/mysqlTable\(\s*"([^"]+)"/g)].map(m => m[1]).sort();
    expect([...new Set(objects.flatMap(o => o.tables))].sort()).toEqual(declaredTables);
    expect(objects.flatMap(o => o.columns)).toHaveLength(319);
  });

  it("refuses to classify a migration containing DDL it does not understand (fails closed)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "guard-parse-"));
    try {
      mkdirSync(path.join(tmp, "drizzle/meta"), { recursive: true });
      cpSync(path.join(root, "drizzle", `${journal.entries[0].tag}.sql`), path.join(tmp, "drizzle", `${journal.entries[0].tag}.sql`));
      const write = sql => { writeFileSync(path.join(tmp, "drizzle/0001_x.sql"), sql); writeFileSync(path.join(tmp, "drizzle/meta/_journal.json"), JSON.stringify({ entries: [journal.entries[0], { tag: "0001_x", when: 1 }] })); };
      for (const bad of ["ALTER TABLE `users` RENAME COLUMN `email` TO `mail`;", "DROP TABLE `users`;", "ALTER TABLE `users` ADD INDEX `i` (`email`);", "INSERT INTO `users` (`openId`) VALUES ('x');"]) {
        write(bad);
        expect(() => migrationObjects(tmp), bad).toThrow(/unrecognised/);
      }
      write("ALTER TABLE `users` ADD COLUMN `nick` text;");
      expect(migrationObjects(tmp)[1].columns).toEqual(["users.nick"]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  const snap = (applied, { extraTables = [], drop = [], lower = false } = {}) => {
    const upto = objects.slice(0, applied);
    const name = n => (lower ? n.toLowerCase() : n);
    const tables = [...upto.flatMap(o => o.tables), ...extraTables].filter(t => !drop.includes(t)).map(name);
    return {
      tables: applied ? ["__drizzle_migrations", ...tables] : tables,
      journal: upto.map((o, i) => ({ id: i + 1 })),
      columns: upto.flatMap(o => o.columns).filter(c => !drop.includes(c)).map(c => `${name(c)} text null=YES default=∅`),
      indexes: upto.flatMap(o => o.indexes).filter(i => !drop.includes(i)).map(i => `${name(i)}#1=x unique=false`),
      counts: Object.fromEntries(tables.map(t => [t, t === "users" ? 2 : 0])),
    };
  };

  it("classifies EMPTY, CONSISTENT_PREFIX, ORPHAN_OR_PARTIAL and DRIFT_MISSING from snapshots", () => {
    expect(classifySchema(snap(0), root)).toMatchObject({ state: "EMPTY", problems: [] });
    expect(classifySchema(snap(0, { extraTables: ["ops_note"] }), root)).toMatchObject({ state: "EMPTY", unmanagedTables: ["ops_note"], problems: [] });
    expect(classifySchema(snap(5), root)).toMatchObject({ state: "CONSISTENT_PREFIX", problems: [], unmanagedObjects: [], tablesWithRows: [{ table: "users", rows: 2 }] });
    expect(classifySchema(snap(objects.length), root)).toMatchObject({ state: "CONSISTENT_PREFIX", pendingTags: [], problems: [] });
    const orphan = classifySchema(snap(3, { extraTables: ["creatorProjects"] }), root);
    expect(orphan.state).toBe("ORPHAN_OR_PARTIAL");
    expect(orphan.problems).toEqual([expect.stringMatching(/table creatorProjects from pending migration 0003_creator_core already exists/)]);
    const drift = classifySchema(snap(5, { drop: ["documents.contentHash", "users.email"] }), root);
    expect(drift.state).toBe("DRIFT_MISSING");
    expect(drift.problems).toHaveLength(2);
  });

  it("compares names case-insensitively (lower_case_table_names=1 servers report lower-case names)", () => {
    expect(classifySchema(snap(objects.length, { lower: true }), root)).toMatchObject({ state: "CONSISTENT_PREFIX", problems: [], unmanagedTables: [], unmanagedObjects: [] });
    expect(classifySchema(snap(3, { extraTables: ["creatorProjects"], lower: true }), root).state).toBe("ORPHAN_OR_PARTIAL");
  });
});

describe("preview-db-setup.yml: environment-scoped credentials", () => {
  const wf = readFileSync(path.join(root, ".github/workflows/preview-db-setup.yml"), "utf8");
  const steps = wf.split(/\n      - name: /).slice(1);
  const stepIndex = name => steps.findIndex(step => step.startsWith(name));
  // the environment expression, evaluated the way GitHub does for `a && 'x' || 'y'` with non-empty string literals
  const environmentFor = mode => {
    const m = /\n    environment: \$\{\{ inputs\.mode == '(\w+)' && '([\w-]+)' \|\| '([\w-]+)' \}\}\n/.exec(wf);
    expect(m, "environment must be selected by an explicit mode mapping").not.toBeNull();
    return mode === m[1] ? m[2] : m[3];
  };

  it("maps each mode to its own environment explicitly", () => {
    expect(environmentFor("inspect")).toBe("sakthiai-preview-db-inspect");
    expect(environmentFor("migrate")).toBe("sakthiai-preview-db-migrate");
  });

  it("reads database credentials only from environment-scoped secret names, never the legacy repository secrets", () => {
    expect(wf).not.toMatch(/SAKTHIAI_PREVIEW_DATABASE_URL|AIVEN_MYSQL_CA_CERT_B64/);
    expect([...new Set(wf.match(/secrets\.[A-Z0-9_]+/g))].sort()).toEqual(["secrets.SAKTHIAI_PREVIEW_DB_CA_B64", "secrets.SAKTHIAI_PREVIEW_DB_URL"]);
    // secrets are bound once, at job level, after the environment is chosen; no step re-binds a different secret
    for (const step of steps) expect(step).not.toMatch(/secrets\./);
    expect(wf.indexOf("environment:")).toBeLessThan(wf.indexOf("secrets.SAKTHIAI_PREVIEW_DB_URL"));
  });

  it("fails before touching the database when the environment's role or credentials are missing or mismatched", () => {
    const config = stepIndex("Require environment-scoped preview database configuration");
    expect(config).toBe(1); // straight after checkout, before any step that uses DATABASE_URL
    const body = steps[config];
    expect(body).toMatch(/ENVIRONMENT_DB_ROLE:-\}" != "\$\{PREVIEW_DB_ROLE\}"/);
    expect(body).toMatch(/-z "\$\{DATABASE_URL:-\}"/);
    expect(body).toMatch(/-z "\$\{DATABASE_CA_CERT_B64:-\}"/);
    expect(body).not.toMatch(/\n        if: /);
    expect(wf).toMatch(/ENVIRONMENT_DB_ROLE: \$\{\{ vars\.SAKTHIAI_PREVIEW_DB_ROLE \}\}/);
    expect(wf).toMatch(/PREVIEW_DB_ROLE: \$\{\{ inputs\.mode \}\}/);
  });

  it("verifies the principal's privileges for the mode before the pre guard and before any write, in both modes", () => {
    const grants = stepIndex("Database principal privileges match the mode");
    expect(grants).toBeGreaterThan(0);
    expect(steps[grants]).toMatch(/run: node scripts\/preview-migration-guard\.mjs grants\n/);
    expect(steps[grants]).not.toMatch(/\n        if: /);
    expect(grants).toBeLessThan(stepIndex("Pre-migration journal"));
    expect(grants).toBeLessThan(stepIndex("Apply preview schema"));
  });

  it("runs no database-writing step in inspect mode", () => {
    const runsIn = (step, mode) => { const m = /\n        if: (.+)\n/.exec(step); if (!m) return true; if (m[1] === "always()") return true; const c = /^inputs\.mode == '(\w+)'$/.exec(m[1]); if (!c) throw new Error(`unrecognised condition ${m[1]}`); return c[1] === mode; };
    const writers = steps.filter(step => /pnpm db:push|db:backfill-search-text/.test(step));
    expect(writers.length).toBe(3);
    for (const step of writers) { expect(runsIn(step, "inspect")).toBe(false); expect(runsIn(step, "migrate")).toBe(true); }
  });

  it("executes the configuration step: only a matching environment role with both credentials passes", async () => {
    const { spawnSync } = await import("node:child_process");
    // the step's literal `run: |` block (10-space indented), extracted without a YAML dependency
    const block = steps[stepIndex("Require environment-scoped preview database configuration")];
    const script = block.split("\n        run: |\n")[1].split("\n").filter(l => l.startsWith("          ") || l === "").map(l => l.slice(10)).join("\n");
    expect(script).toMatch(/^set -euo pipefail/);
    const run = env => spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    const full = { DATABASE_URL: "mysql://u:p@h.aivencloud.com:1/sakthiai_preview", DATABASE_CA_CERT_B64: "Y2E=" };
    expect(run({ ...full, PREVIEW_DB_ROLE: "inspect", ENVIRONMENT_DB_ROLE: "inspect" }).status).toBe(0);
    expect(run({ ...full, PREVIEW_DB_ROLE: "migrate", ENVIRONMENT_DB_ROLE: "migrate" }).status).toBe(0);
    const refused = [
      { ...full, PREVIEW_DB_ROLE: "migrate", ENVIRONMENT_DB_ROLE: "inspect" }, // migrate dispatched into the inspect environment
      { ...full, PREVIEW_DB_ROLE: "inspect", ENVIRONMENT_DB_ROLE: "migrate" },
      { ...full, PREVIEW_DB_ROLE: "inspect" }, // environment variable missing (e.g. environment not created)
      { ...full, PREVIEW_DB_ROLE: "drop", ENVIRONMENT_DB_ROLE: "drop" },
      { DATABASE_CA_CERT_B64: "Y2E=", PREVIEW_DB_ROLE: "inspect", ENVIRONMENT_DB_ROLE: "inspect" },
      { DATABASE_URL: full.DATABASE_URL, PREVIEW_DB_ROLE: "inspect", ENVIRONMENT_DB_ROLE: "inspect" },
    ];
    for (const env of refused) {
      const r = run(env);
      expect(r.status, JSON.stringify({ ...env, DATABASE_URL: env.DATABASE_URL ? "<set>" : undefined })).not.toBe(0);
      expect(r.stdout + r.stderr).not.toMatch(/u:p@/); // never echoes the credential
    }
  });

  it("does not expose the credentials to dependency install, typecheck or unit tests", () => {
    for (const name of ["Install dependencies", "Typecheck", "Unit and regression tests"]) {
      expect(steps[stepIndex(name)], name).toMatch(/\n        env:\n          DATABASE_URL: ""\n          DATABASE_CA_CERT_B64: ""\n/);
    }
  });
});

describe("preview migration guard: principal privileges (SHOW GRANTS)", () => {
  const db = "sakthiai_preview";
  const g = (privs, on = "`sakthiai_preview`.*", tail = "") => `GRANT ${privs} ON ${on} TO \`u\`@\`%\`${tail}`;
  const usage = "GRANT USAGE ON *.* TO `u`@`%`";

  it("inspect accepts exactly SELECT on the target database (escaped underscore included)", () => {
    expect(checkPrincipalGrants([usage, g("SELECT")], "inspect", db)).toEqual({ privileges: ["SELECT"], problems: [] });
    expect(checkPrincipalGrants([usage, g("SELECT", "`sakthiai\\_preview`.*")], "inspect", db).problems).toEqual([]);
  });

  it("inspect refuses any write, DDL, ALL, global, other-database, wildcard, table, role or grant-option grant", () => {
    const refused = [
      [g("SELECT, INSERT")], [g("SELECT, CREATE")], [g("ALL PRIVILEGES")], [g("SELECT", "*.*")], [g("SELECT"), g("SELECT", "`defaultdb`.*")],
      [g("SELECT", "`sakthiai%`.*")], [g("SELECT"), g("SELECT", "`sakthiai_preview`.`users`")], [g("SELECT"), "GRANT `admin_role`@`%` TO `u`@`%`"],
      [g("SELECT", "`sakthiai_preview`.*", " WITH GRANT OPTION")], [usage, "GRANT APPLICATION_PASSWORD_ADMIN ON *.* TO `u`@`%`", g("SELECT")], [usage],
    ];
    for (const lines of refused) expect(checkPrincipalGrants(lines, "inspect", db).problems.length, lines.join(" | ")).toBeGreaterThan(0);
  });

  it("migrate requires the migration privileges and refuses DROP, ALL and missing privileges", () => {
    const need = "SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX";
    expect(checkPrincipalGrants([usage, g(need)], "migrate", db).problems).toEqual([]);
    expect(checkPrincipalGrants([usage, g(`${need}, DELETE`)], "migrate", db).problems).toEqual([]);
    expect(checkPrincipalGrants([g(`${need}, DROP`)], "migrate", db).problems.join()).toMatch(/DROP .* not allowed/);
    expect(checkPrincipalGrants([g("ALL PRIVILEGES")], "migrate", db).problems.length).toBeGreaterThan(0);
    expect(checkPrincipalGrants([g("SELECT, INSERT, UPDATE, CREATE, ALTER")], "migrate", db).problems.join()).toMatch(/requires INDEX/);
    // the migrate principal can never pass as inspect, and an unknown role fails
    expect(checkPrincipalGrants([g(need)], "inspect", db).problems.length).toBeGreaterThan(0);
    expect(checkPrincipalGrants([g("SELECT")], undefined, db).problems.join()).toMatch(/unknown PREVIEW_DB_ROLE/);
  });

  it("reports tables whose rows the recovery-point check cannot see", () => {
    const snap = { columns: ["users.createdAt timestamp null=NO", "durableTasks.createdAt datetime(3) null=NO", "documentChunks.content text null=NO"], counts: { users: 1, durableTasks: 2, documentChunks: 3, empty: 0 } };
    expect(recoveryUncoveredTables(snap)).toEqual([{ table: "documentChunks", rows: 3 }]);
  });
});

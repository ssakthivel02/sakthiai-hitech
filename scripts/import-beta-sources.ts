// OPERATOR-ONLY. Imports the approved SYNTHETIC English/Tamil beta sources into designated beta workspaces.
//
//   List candidate workspaces (read-only):
//     DATABASE_URL=... AUTH_ALLOWED_EMAILS=... pnpm ops:import-beta-sources --list-workspaces
//   Dry run (default; read-only, prints the plan and the confirmation token):
//     ... pnpm ops:import-beta-sources --workspace-id 3 --workspace-id 4
//   Apply (writes; needs the token from the dry run and the exact database name):
//     ... pnpm ops:import-beta-sources --workspace-id 3 --apply --confirm IMPORT-XXXXXXXXXXXXXXXX --expect-database <name>
//
// The login allowlist env (AUTH_ALLOWED_SUBJECTS / AUTH_ALLOWED_EMAILS / OWNER_OPEN_ID) must be the same as the target
// deployment's: a workspace is designated only when its owner is on that allowlist. Open or closed policies are refused.
// Output never contains emails, openIds, connection strings or secrets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { documents, users, workspaces } from "../drizzle/schema";
import { isSessionUserAllowed, loginAccessPolicy } from "../server/_core/authAccess";
import { getDb } from "../server/db";
import { applyImport, confirmationToken, currentDatabaseName, ImportRefusal, loadCorpus, planImport, verifyImport } from "../server/ops/betaSourceImport";

type Args = { list: boolean; apply: boolean; workspaceIds: number[]; confirm: string; expectDatabase: string; dir: string; unknown: string[] };

export function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, apply: false, workspaceIds: [], confirm: "", expectDatabase: "", dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release/beta-sources"), unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? "";
    if (arg === "--list-workspaces") args.list = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--workspace-id") args.workspaceIds.push(Number(value()));
    else if (arg === "--confirm") args.confirm = value();
    else if (arg === "--expect-database") args.expectDatabase = value();
    else if (arg === "--corpus-dir") args.dir = path.resolve(value());
    else args.unknown.push(arg);
  }
  return args;
}

const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length) { console.error(`IMPORT_REFUSED: unknown argument(s): ${args.unknown.join(" ")}`); return 2; }
  const db = await getDb();
  if (!db) { console.error("IMPORT_FAIL: DATABASE_URL is not configured or the verified connection failed"); return 1; }
  // production=true: an unset allowlist means "closed", never "open", so the tool cannot be used without an explicit allowlist.
  const policy = loginAccessPolicy(process.env, true);
  const databaseName = await currentDatabaseName(db);

  if (args.list) {
    const rows = await db.select({ id: workspaces.id, name: workspaces.name, ownerUserId: workspaces.ownerUserId }).from(workspaces);
    const result = [];
    for (const row of rows) {
      const owner = (await db.select({ openId: users.openId, email: users.email }).from(users).where(eq(users.id, row.ownerUserId)).limit(1))[0];
      const [counted] = (await db.select({ n: sql<number>`COUNT(*)` }).from(documents).where(eq(documents.workspaceId, row.id)));
      result.push({ workspaceId: row.id, name: row.name, ownerUserId: row.ownerUserId, ownerOnAllowlist: Boolean(owner && isSessionUserAllowed(policy, owner)), documents: Number(counted?.n ?? 0) });
    }
    out({ mode: "list-workspaces", databaseName, loginPolicyMode: policy.mode, workspaces: result });
    return 0;
  }

  const corpus = await loadCorpus(args.dir);
  const plan = await planImport({ db, corpus, workspaceIds: args.workspaceIds, policy });
  const token = plan.ok ? confirmationToken(corpus, plan.workspaces.map(w => w.workspaceId), plan.databaseName) : null;

  if (!args.apply) {
    out({ mode: "dry-run", wrote: false, corpusId: corpus.corpusId, documents: corpus.documents.length, plan, confirmationToken: token });
    return plan.ok ? 0 : 2;
  }
  const report = await applyImport({ db, corpus, plan, confirm: args.confirm, expectDatabase: args.expectDatabase });
  const verification = [];
  for (const entry of report.workspaces) verification.push({ workspaceId: entry.workspaceId, ...(await verifyImport(db, corpus, entry.workspaceId)) });
  out({ mode: "apply", wrote: true, report, verification });
  return verification.every(v => v.ok) ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    if (error instanceof ImportRefusal) { console.error(`IMPORT_REFUSED: ${error.message}${error.reasons.length ? `\n - ${error.reasons.join("\n - ")}` : ""}`); process.exit(2); }
    console.error(`IMPORT_FAIL: ${error instanceof Error ? error.message : "unexpected error"}`);
    process.exit(1);
  });

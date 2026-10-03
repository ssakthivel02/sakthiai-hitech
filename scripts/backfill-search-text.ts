// Fills documentChunks.searchText for rows ingested before migration 0006. Idempotent; safe to re-run.
// Usage: DATABASE_URL=... pnpm db:backfill-search-text   (it only UPDATEs searchText of rows where it is NULL)
import { getDb } from "../server/db";
import { backfillSearchText } from "../server/retrievalStore";

const db = await getDb();
if (!db) {
  console.error("BACKFILL_FAIL: DATABASE_URL is not configured or the verified connection failed");
  process.exit(1);
}
const updated = await backfillSearchText(db);
console.log(`BACKFILL_DONE updated=${updated}`);
process.exit(0);

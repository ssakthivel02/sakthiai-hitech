// Fills documentChunks.searchText for rows ingested before migration 0006 (NULL) AND upgrades rows indexed before the
// Tamil<->Tanglish transliteration key block existed (no ~tl~ marker). Idempotent; safe to re-run; a finished table updates 0.
// Usage: DATABASE_URL=... pnpm db:backfill-search-text
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

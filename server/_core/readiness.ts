import { sql } from "drizzle-orm";
import { getDb } from "../db";

type LiveDatabaseProbe = () => Promise<unknown>;

export async function probeDatabaseReadiness(liveProbe?: LiveDatabaseProbe): Promise<boolean> {
  try {
    if (liveProbe) {
      await liveProbe();
      return true;
    }

    const db = await getDb();
    if (!db) return false;

    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

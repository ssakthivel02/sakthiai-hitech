import { getDb } from "../db";
import { MysqlSentinelStore } from "./store.mysql";

let store: MysqlSentinelStore | null = null;
/** Process-wide Sentinel store. Constructing it touches nothing; the database is only used when a Sentinel API/handler actually runs. */
export const getSharedSentinelStore = (): MysqlSentinelStore => (store ??= new MysqlSentinelStore(getDb));
export const resetSentinelStoreForTests = (): void => { store = null; };

import { getDb } from "../db";
import { UploadCleanupRunner, cleanupConfigFromEnv } from "./cleanupRunner";
import { UploadStore } from "./store";

let runner: UploadCleanupRunner | null = null;
export const getUploadCleanupRunner = () => (runner ??= new UploadCleanupRunner({ store: new UploadStore(getDb), config: cleanupConfigFromEnv(), log: line => console.log(line) }));
export const resetUploadCleanupRunnerForTests = () => { runner = null; };

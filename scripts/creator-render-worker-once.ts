import "dotenv/config";
import { quarantineExpiredCreatorRenderClaims, runCreatorRenderQueueBatch } from "../server/creator/renderAsyncWorker";

/**
 * Explicit one-shot worker entry point. No automatic startup, scheduler,
 * retry, paid generation or publish. Requires
 * CREATOR_ASYNC_RENDER_WORKER_ENABLED=true.
 */
const limit = Number(process.env.CREATOR_RENDER_WORKER_BATCH_LIMIT ?? "1");
const shutdown = new AbortController();
const requestShutdown = () => shutdown.abort();
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
try {
  if (process.env.CREATOR_ASYNC_RENDER_WORKER_ENABLED !== "true") {
    throw new Error("CREATOR_RENDER_ASYNC_WORKER_DISABLED");
  }
  if (shutdown.signal.aborted) throw new Error("CREATOR_RENDER_WORKER_STOP_REQUESTED");
  const quarantined = await quarantineExpiredCreatorRenderClaims(limit);
  const result = await runCreatorRenderQueueBatch(limit, { abortSignal: shutdown.signal });
  console.log(JSON.stringify({
    kind: "creator-render-worker-batch",
    quarantined: quarantined.length,
    attempted: result.attempted,
    dispatched: result.dispatched,
    skipped: result.skipped,
    failed: result.failed,
    interrupted: result.interrupted,
    results: result.results,
  }));
  if (result.failed || result.interrupted) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code = /^CREATOR_[A-Z0-9_]+$/.test(message)
    ? message : "CREATOR_RENDER_WORKER_FATAL";
  console.error(code);
  process.exitCode = 1;
 finally {
  process.off("SIGINT", requestShutdown);
  process.off("SIGTERM", requestShutdown);
}

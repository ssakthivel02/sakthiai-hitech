import "dotenv/config";
import { runCreatorRenderQueueBatch } from "../server/creator/renderAsyncWorker";

/**
 * Explicit one-shot worker entry point. No automatic startup, scheduler,
 * retry, paid generation or publish. Requires
 * CREATOR_ASYNC_RENDER_WORKER_ENABLED=true.
 */
const limit = Number(process.env.CREATOR_RENDER_WORKER_BATCH_LIMIT ?? "1");
try {
  const result = await runCreatorRenderQueueBatch(limit);
  console.log(JSON.stringify({
    kind: "creator-render-worker-batch",
    attempted: result.attempted,
    dispatched: result.dispatched,
    skipped: result.skipped,
    failed: result.failed,
    results: result.results,
  }));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code = /^CREATOR_[A-Z0-9_]+$/.test(message)
    ? message : "CREATOR_RENDER_WORKER_FATAL";
  console.error(code);
  process.exitCode = 1;
}

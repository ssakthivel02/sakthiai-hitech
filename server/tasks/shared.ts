import { getDb } from "../db";
import { getProviderGateway } from "../gateway";
import { createChatAnswerHandler, CHAT_ANSWER_TASK } from "./chatAnswer";
import { getSharedMcpService } from "../connectors/mcp/shared";
import { SENTINEL_INVESTIGATE_TASK, sentinelEnabled } from "../sentinel/config";
import { createSentinelInvestigateHandler } from "../sentinel/handler";
import { getSharedSentinelStore } from "../sentinel/shared";
import { MysqlTaskStore } from "./store";
import { TaskWorkerRuntime, runtimeConfigFromEnv } from "./runtime";

let store: MysqlTaskStore | null = null;
export const getSharedTaskStore = () => (store ??= new MysqlTaskStore(getDb));
export const taskHandlers = () => ({
  [CHAT_ANSWER_TASK]: createChatAnswerHandler({ mcp: { service: getSharedMcpService() } }),
  /** Sentinel incident investigation: registered ONLY when SENTINEL_ENABLED=true (default off). */
  ...(sentinelEnabled() ? { [SENTINEL_INVESTIGATE_TASK]: createSentinelInvestigateHandler({ store: getSharedSentinelStore(), mcp: getSharedMcpService() }) } : {}),
});

let runtime: TaskWorkerRuntime | null = null;
export const getTaskRuntime = () => (runtime ??= new TaskWorkerRuntime({
  store: getSharedTaskStore(), handlers: taskHandlers(), config: runtimeConfigFromEnv(),
  gateway: { invoke: request => getProviderGateway().invoke(request) },
}));
export const resetTaskRuntimeForTests = () => { runtime = null; store = null; };

/** chat.sendAsync is only available when the worker runtime is explicitly enabled. */
export const asyncAnswersEnabled = (env: NodeJS.ProcessEnv = process.env) => runtimeConfigFromEnv(env).enabled;

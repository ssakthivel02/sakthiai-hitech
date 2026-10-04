import { getDb } from "../db";
import { getProviderGateway } from "../gateway";
import { createChatAnswerHandler, CHAT_ANSWER_TASK } from "./chatAnswer";
import { MysqlTaskStore } from "./store";
import { TaskWorkerRuntime, runtimeConfigFromEnv } from "./runtime";

let store: MysqlTaskStore | null = null;
export const getSharedTaskStore = () => (store ??= new MysqlTaskStore(getDb));
export const taskHandlers = () => ({ [CHAT_ANSWER_TASK]: createChatAnswerHandler() });

let runtime: TaskWorkerRuntime | null = null;
export const getTaskRuntime = () => (runtime ??= new TaskWorkerRuntime({
  store: getSharedTaskStore(), handlers: taskHandlers(), config: runtimeConfigFromEnv(),
  gateway: { invoke: request => getProviderGateway().invoke(request) },
}));
export const resetTaskRuntimeForTests = () => { runtime = null; store = null; };

/** chat.sendAsync is only available when the worker runtime is explicitly enabled. */
export const asyncAnswersEnabled = (env: NodeJS.ProcessEnv = process.env) => runtimeConfigFromEnv(env).enabled;

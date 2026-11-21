import { loadGatewayConfig } from "./config";
import { MysqlBreakerStore, MysqlBudgetStore, MysqlWorkspacePolicyResolver, type DbProvider } from "./mysqlStores";
import { createProviderGateway, type GatewayDependencies, type ProviderGateway } from "./gateway";

export * from "./types";
export * from "./budget";
export * from "./circuitBreaker";
export * from "./config";
export * from "./gateway";
export { createOpenAiCompatibleAdapter } from "./openaiCompatible";
export * from "./mysqlStores";

let instance: ProviderGateway | null = null;

/**
 * The single chat-model invocation boundary. Built lazily from the environment so that
 * importing this module never reads secrets or opens connections.
 */
export function getProviderGateway(): ProviderGateway {
  if (!instance) instance = buildGatewayFromEnv(process.env);
  return instance;
}

/** Test seam: replace (or clear with null) the process-wide gateway. */
export function setProviderGatewayForTests(gateway: ProviderGateway | null) {
  instance = gateway;
}

const defaultDb: DbProvider = async () => (await import("../db")).getDb();

/**
 * GATEWAY_STATE_STORE=mysql shares breaker state, per-workspace provider policy and usage budgets across
 * instances via the application database. Explicitly injected deps always win (tests).
 */
export function buildGatewayFromEnv(env: Record<string, string | undefined>, deps: GatewayDependencies = {}, getDb: DbProvider = defaultDb) {
  const config = loadGatewayConfig(env);
  const shared: GatewayDependencies =
    config.stateStore === "mysql"
      ? { breakerStore: new MysqlBreakerStore(getDb), budgetStore: new MysqlBudgetStore(getDb), policyResolver: new MysqlWorkspacePolicyResolver(getDb) }
      : {};
  return createProviderGateway(config, { ...shared, ...deps });
}

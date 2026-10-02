import { loadGatewayConfig } from "./config";
import { createProviderGateway, type GatewayDependencies, type ProviderGateway } from "./gateway";

export * from "./types";
export * from "./budget";
export * from "./circuitBreaker";
export * from "./config";
export * from "./gateway";
export { createOpenAiCompatibleAdapter } from "./openaiCompatible";

let instance: ProviderGateway | null = null;

/**
 * The single chat-model invocation boundary. Built lazily from the environment so that
 * importing this module never reads secrets or opens connections.
 */
export function getProviderGateway(): ProviderGateway {
  if (!instance) instance = createProviderGateway(loadGatewayConfig(process.env));
  return instance;
}

/** Test seam: replace (or clear with null) the process-wide gateway. */
export function setProviderGatewayForTests(gateway: ProviderGateway | null) {
  instance = gateway;
}

export function buildGatewayFromEnv(env: Record<string, string | undefined>, deps?: GatewayDependencies) {
  return createProviderGateway(loadGatewayConfig(env), deps);
}

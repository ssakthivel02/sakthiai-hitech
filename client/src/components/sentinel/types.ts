import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type SentinelView = RouterOutputs["sentinel"]["get"];
export type SentinelSummary = RouterOutputs["sentinel"]["list"]["items"][number];
export type SentinelStatusInfo = RouterOutputs["sentinel"]["status"];
export type EvidenceItem = SentinelView["evidence"][number];
export type ToolCall = SentinelView["toolCalls"][number];
export type Hypothesis = SentinelView["hypotheses"]["latest"][number];
export type ConnectorCatalog = RouterOutputs["sentinel"]["connectorCatalog"];
export type ConnectorInfo = ConnectorCatalog["connectors"][number];
export type DiscoveryResult = RouterOutputs["connectors"]["mcp"]["discover"];
export type ConnectorAuditRow = RouterOutputs["connectors"]["mcp"]["audit"][number];

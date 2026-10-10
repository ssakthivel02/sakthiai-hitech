import { getDb } from "../../db";
import { McpConnectorService } from "./service";
import { McpConnectorStore } from "./store";

let service: McpConnectorService | null = null;
export const getSharedMcpService = () => (service ??= new McpConnectorService({ store: new McpConnectorStore(getDb) }));

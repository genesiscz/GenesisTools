import type { MCPProvider } from "../utils/providers/types.js";
import { toggleServer } from "./toggle-server.js";

/**
 * Enable MCP server(s) in selected provider(s)
 */
export async function enableServer(serverNameArg: string | undefined, providers: MCPProvider[]): Promise<void> {
    await toggleServer(true, serverNameArg, providers);
}

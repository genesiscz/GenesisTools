import type { MCPProvider } from "../utils/providers/types.js";
import { toggleServer } from "./toggle-server.js";

/**
 * Disable MCP server(s) in selected provider(s)
 */
export async function disableServer(serverNameArg: string | undefined, providers: MCPProvider[]): Promise<void> {
    await toggleServer(false, serverNameArg, providers);
}

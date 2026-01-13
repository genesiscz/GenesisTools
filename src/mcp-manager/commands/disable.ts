import type { MCPProvider } from "../utils/providers/types.js";
import { toggleServer, type ToggleOptions } from "./toggle-server.js";

/**
 * Disable MCP server(s) in selected provider(s)
 */
export async function disableServer(
    serverNameArg: string | undefined,
    providers: MCPProvider[],
    options: ToggleOptions = {}
): Promise<void> {
    await toggleServer(false, serverNameArg, providers, options);
}

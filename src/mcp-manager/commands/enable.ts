import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import { toggleServer, type ToggleOptions } from "./toggle-server.js";

/**
 * Enable MCP server(s) in selected provider(s)
 */
export async function enableServer(
    serverNameArg: string | undefined,
    providers: MCPProvider[],
    options: ToggleOptions = {}
): Promise<void> {
    await toggleServer(true, serverNameArg, providers, options);
}

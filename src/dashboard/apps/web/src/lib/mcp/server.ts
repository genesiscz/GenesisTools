import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks";
import { registerTimerTools } from "./tools/timers";

/**
 * Build an MCP server bound to a single owner user. All tools operate ONLY on
 * that user's data — there is no userId tool argument and no cross-user access.
 */
export function createMcpServer(userId: string): McpServer {
    const server = new McpServer({ name: "nexus-dashboard", version: "0.1.0" });
    registerTaskTools(server, userId);
    registerTimerTools(server, userId);
    return server;
}

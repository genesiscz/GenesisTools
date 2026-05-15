import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks";
import { registerTimerTools } from "./tools/timers";

export function createMcpServer(): McpServer {
    const server = new McpServer({ name: "nexus-dashboard", version: "0.1.0" });
    registerTaskTools(server);
    registerTimerTools(server);
    return server;
}

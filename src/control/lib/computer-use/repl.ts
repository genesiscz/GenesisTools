import { startMcpServer } from "@app/node-repl/mcp/server";

/** `tools computer-use mcp --repl`: the node-repl MCP server with the `computer` toolset preloaded. */
export function startComputerReplServer(): Promise<void> {
    return startMcpServer({ toolsets: ["computer"], name: "computer-use-repl" });
}

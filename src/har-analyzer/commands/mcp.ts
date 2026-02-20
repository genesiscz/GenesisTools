import type { Command } from "commander";

export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Start MCP server for Claude integration")
        .action(async () => {
            const { startMcpServer } = await import("@app/har-analyzer/mcp/server");
            await startMcpServer();
        });
}

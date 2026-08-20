import type { Command } from "commander";

export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Start an MCP server for the Teams reader")
        .action(async () => {
            const { startMcpServer } = await import("@app/ms-teams/mcp/server");
            await startMcpServer();
        });
}

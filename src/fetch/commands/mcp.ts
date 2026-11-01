import type { Command } from "commander";

/** `tools fetch mcp`: the fetch_* tools as a stdio MCP server of their own. */
export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Run the fetch_markdown, fetch_raw and fetch_jsonld tools as a stdio MCP server")
        .action(async () => {
            const { startFetchMcpServer } = await import("../mcp/server");
            await startFetchMcpServer();
        });
}

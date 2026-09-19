import type { Command } from "commander";
import { failPlain } from "../lib/cli-output";
import { startJevMcpServer } from "./server";

export function registerJevMcp(program: Command): void {
    program
        .command("mcp")
        .description(
            "Start the read-only Jev MCP server on stdio (jev_route, jev_compact, jev_verify, jev_verify_templates)"
        )
        .action(async () => {
            try {
                await startJevMcpServer();
            } catch (error) {
                failPlain(error, { command: "mcp" });
            }
        });
}

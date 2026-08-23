import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { registerMcpInstallCommand } from "./mcp-install";

const log = logger.child({ component: "claude:mcp-cmd" });

export function registerMcpCommand(program: Command): void {
    const mcp = program
        .command("mcp")
        .description(
            "Run the genesis-tools MCP server (stdio) — exposes question_answer + boards. " +
                "Set GENESIS_TOOLS_MCP_CAPABILITIES (comma-delimited, e.g. question_answer,boards) to restrict."
        )
        .action(async () => {
            log.info("starting MCP server");
            // Deferred: the MCP SDK graph costs ~180ms to import and is only
            // needed once the server actually starts.
            const { startMcpServer } = await import("@app/claude/mcp/server");
            await startMcpServer();
        });
    registerMcpInstallCommand(mcp);
}

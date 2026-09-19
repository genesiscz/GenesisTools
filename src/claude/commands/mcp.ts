import { registerMcpInstallCommand } from "@app/genesis-tools-mcp/lib/mcp-install";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const log = logger.child({ component: "claude:mcp-cmd" });

export function registerMcpCommand(program: Command): void {
    const mcp = program
        .command("mcp")
        .description(
            "Run the genesis-tools MCP server (stdio) — exposes question_answer + boards " +
                "(alias of tools genesis-tools-mcp). " +
                "Set GENESIS_TOOLS_MCP_CAPABILITIES (comma-delimited, e.g. question_answer,boards) to restrict."
        )
        .action(async () => {
            log.info("starting MCP server");
            // Deferred: the MCP SDK graph costs ~180ms to import and is only
            // needed once the server actually starts.
            const { startMcpServer } = await import("@app/genesis-tools-mcp/lib/server");
            await startMcpServer();
        });
    registerMcpInstallCommand(mcp);
}

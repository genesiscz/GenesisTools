#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerMcpInstallCommand } from "./lib/mcp-install";

const log = logger.child({ component: "genesis-tools-mcp" });

const program = new Command();

program
    .name("genesis-tools-mcp")
    .description(
        "Run the genesis-tools MCP server (stdio) — exposes question_answer + boards. " +
            "Set GENESIS_TOOLS_MCP_CAPABILITIES (comma-delimited, e.g. question_answer,boards) to restrict."
    )
    .action(async () => {
        log.info("starting MCP server");
        // Deferred: the MCP SDK graph costs ~180ms to import and is only
        // needed once the server actually starts.
        const { startMcpServer } = await import("./lib/server");
        await startMcpServer();
    });

registerMcpInstallCommand(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "genesis-tools-mcp" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error: ${message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});

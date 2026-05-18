import { startMcpServer } from "@app/claude/mcp/server";
import logger from "@app/logger";
import type { Command } from "commander";
import { registerMcpInstallCommand } from "./mcp-install";

const log = logger.child({ component: "claude:mcp-cmd" });

export function registerMcpCommand(program: Command): void {
    const mcp = program
        .command("mcp")
        .description("Run the genesis-tools MCP server (stdio) — exposes question_answer")
        .action(async () => {
            log.info("starting MCP server");
            await startMcpServer();
        });
    registerMcpInstallCommand(mcp);
}

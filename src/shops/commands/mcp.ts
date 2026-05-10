import logger from "@app/logger";
import type { Command } from "commander";
import { startMcpServer } from "@app/shops/mcp/server";

const log = logger.child({ component: "shops:mcp-cmd" });

export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Run the shops MCP server (stdio transport) for Claude Code integration")
        .option("--allow-write", "Enable write tools (ingest, accept-match, watch_*, notify_ack)", false)
        .action(async (opts: { allowWrite?: boolean }) => {
            const allowWrite = opts.allowWrite === true;
            log.info({ allowWrite }, "starting MCP server");
            await startMcpServer({ allowWrite });
        });
}

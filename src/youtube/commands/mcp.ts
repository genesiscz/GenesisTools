import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { startMcpServer } from "@app/youtube/lib/mcp/server";
import type { Command } from "commander";

export function registerMcpCommand(program: Command): void {
    program
        .command("mcp")
        .description("Serve the curated youtube tool set over MCP (stdio)")
        .addHelpText(
            "after",
            "\nRegister with an MCP client as: tools youtube mcp\n" +
                "Exposes list_videos, get_video, search_transcripts, transcript_window, ask, queue_add, queue_status.\n" +
                "Admin, billing, cache and config writes are deliberately not exposed.\n"
        )
        .action(async () => {
            // stdio IS the protocol channel here, so nothing may print to stdout
            // besides MCP frames. The logger writes to stderr, which is safe.
            const yt = await getYoutube();
            await startMcpServer(yt);
        });
}

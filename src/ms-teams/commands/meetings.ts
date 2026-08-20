import { openCache } from "@app/ms-teams/lib/cache";
import { printConversations } from "@app/ms-teams/lib/display";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerMeetingsCommand(program: Command): void {
    program
        .command("meetings")
        .description("List cached meeting chats")
        .option("--with <name>", "Filter by participant")
        .option("--json", "Machine-readable JSON")
        .action((opts: { with?: string; json?: boolean }) => {
            const cache = openCache();

            try {
                const rows = cache.listConversations({ type: "meeting", withName: opts.with, limit: 100 });

                if (opts.json) {
                    out.result(rows);
                    return;
                }

                printConversations(rows);
            } finally {
                cache.close();
            }
        });
}

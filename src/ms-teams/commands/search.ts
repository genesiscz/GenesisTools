import { openCache } from "@app/ms-teams/lib/cache";
import { printSearchHits } from "@app/ms-teams/lib/display";
import { parseQueryDate } from "@app/ms-teams/lib/query";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerSearchCommand(program: Command): void {
    program
        .command("search <text...>")
        .description("Full-text search over cached message bodies")
        .option("--with <name>", "Restrict to chats involving this person")
        .option("--in <id>", "Restrict to one conversation id")
        .option("--from <date>", "Messages after this date")
        .option("--to <date>", "Messages before this date")
        .option("--limit <n>", "Max hits", "50")
        .option("--json", "Machine-readable JSON")
        .action(
            (
                textParts: string[],
                opts: { with?: string; in?: string; from?: string; to?: string; limit?: string; json?: boolean }
            ) => {
                const cache = openCache();

                try {
                    const hits = cache.searchMessages(textParts.join(" "), {
                        withName: opts.with,
                        conversationId: opts.in,
                        from: opts.from ? parseQueryDate(opts.from, "start") : undefined,
                        to: opts.to ? parseQueryDate(opts.to, "end") : undefined,
                        limit: Number.parseInt(opts.limit ?? "50", 10),
                    });

                    if (opts.json) {
                        out.result(hits);
                        return;
                    }

                    if (hits.length === 0) {
                        out.println("No matches.");
                        return;
                    }

                    printSearchHits(hits, (id) => cache.getConversation(id)?.title ?? id);
                } finally {
                    cache.close();
                }
            }
        );
}

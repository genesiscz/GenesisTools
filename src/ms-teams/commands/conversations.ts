import { openCache } from "@app/ms-teams/lib/cache";
import { printConversations } from "@app/ms-teams/lib/display";
import { parseQueryDate } from "@app/ms-teams/lib/query";
import type { ConversationType } from "@app/ms-teams/lib/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerConversationsCommand(program: Command): void {
    for (const name of ["conversations", "chats", "list"]) {
        program
            .command(name)
            .description("List cached Teams conversations")
            .option("--type <type>", "meeting | chat | space | topic | group")
            .option("--with <name>", "Filter by participant or title")
            .option("--topic <text>", "Filter by topic or title")
            .option("--from <date>", "Last activity after this date")
            .option("--to <date>", "Last activity before this date")
            .option("--limit <n>", "Max rows", "40")
            .option("--json", "Machine-readable JSON")
            .action(
                (opts: {
                    type?: string;
                    with?: string;
                    topic?: string;
                    from?: string;
                    to?: string;
                    limit?: string;
                    json?: boolean;
                }) => {
                    const cache = openCache();

                    try {
                        const rows = cache.listConversations({
                            type: opts.type as ConversationType | "group" | undefined,
                            withName: opts.with,
                            topic: opts.topic,
                            from: opts.from ? parseQueryDate(opts.from, "start") : undefined,
                            to: opts.to ? parseQueryDate(opts.to, "end") : undefined,
                            limit: parsePositiveLimit(opts.limit, 40),
                        });

                        if (opts.json) {
                            out.result(rows);
                            return;
                        }

                        if (rows.length === 0) {
                            out.println("No conversations matched.");
                            return;
                        }

                        printConversations(rows);
                    } finally {
                        cache.close();
                    }
                }
            );
    }
}

export function parsePositiveLimit(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }

    const trimmed = value.trim();

    if (!/^[0-9]+$/.test(trimmed)) {
        throw new Error(`Invalid --limit ${value}. Use a positive integer.`);
    }

    const n = Number(trimmed);

    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`Invalid --limit ${value}. Use a positive integer.`);
    }

    return n;
}

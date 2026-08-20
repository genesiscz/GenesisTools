import { openCache } from "@app/ms-teams/lib/cache";
import { formatDateTime } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function registerMentionsCommand(program: Command): void {
    program
        .command("mentions")
        .description("List cached activity-feed items (mentions and reactions)")
        .option("--json", "Machine-readable JSON")
        .action((opts: { json?: boolean }) => {
            const cache = openCache();

            try {
                const rows = cache.listActivity();

                if (opts.json) {
                    out.result(rows);
                    return;
                }

                renderCliHeader("Teams activity", `${rows.length} items`);
                const table = createBoxTable(["WHEN", "TYPE", "SUB", "THREAD"]);

                for (const row of rows) {
                    table.push([
                        row.timestamp ? formatDateTime(row.timestamp, { absolute: "datetime" }) : "—",
                        row.activityType,
                        row.activitySubtype ?? "—",
                        truncateDisplay(row.sourceThreadId ?? "—", 40),
                    ]);
                }

                out.println(table.toString());
            } finally {
                cache.close();
            }
        });
}

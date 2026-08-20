import { openCache } from "@app/ms-teams/lib/cache";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function registerCallsCommand(program: Command): void {
    program
        .command("calls")
        .description("List cached call-history records")
        .option("--json", "Machine-readable JSON")
        .action((opts: { json?: boolean }) => {
            const cache = openCache();

            try {
                const rows = cache.listCalls();

                if (opts.json) {
                    out.result(rows);
                    return;
                }

                renderCliHeader("Teams calls", `${rows.length} records`);
                const table = createBoxTable(["START", "TYPE", "STATE", "DIR", "THREAD"]);

                for (const row of rows) {
                    table.push([
                        truncateDisplay(row.startTime ?? "—", 24),
                        row.callType ?? "—",
                        row.callState ?? "—",
                        row.callDirection ?? "—",
                        truncateDisplay(row.threadId ?? "—", 36),
                    ]);
                }

                out.println(table.toString());
            } finally {
                cache.close();
            }
        });
}

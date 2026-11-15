import { framesCell, listLibrary, shortRecordingId } from "@app/recorder/lib/library";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("list")
        .description("The recordings library, newest first (or the running recordings with --live)")
        .option("--live", "the recordings that run now")
        .option("--limit <n>", "at most this many rows", "20")
        .option("--json", "JSON on stdout")
        .action((flags: { live?: boolean; limit: string; json?: boolean }) => {
            const limit = Math.max(1, Number(flags.limit) || 20);

            if (flags.live) {
                const entries = listLiveRecordings().slice(0, limit);
                if (flags.json) {
                    out.result(entries);
                    return;
                }

                const table = createBoxTable(["ID", "KIND", "STATE", "TITLE", "STARTED"]);
                for (const entry of entries) {
                    table.push([
                        entry.id,
                        entry.kind,
                        entry.state,
                        entry.title,
                        formatLocalDateTimeStamp(entry.startedAt),
                    ]);
                }

                out.println(entries.length ? table.toString() : "No recording is running.");
                return;
            }

            const rows = listLibrary({ limit });
            if (flags.json) {
                out.result(rows);
                return;
            }

            renderCliHeader("Recordings", `${rows.length} newest`);
            const table = createBoxTable(["ID", "TITLE", "STARTED", "LENGTH", "OUTCOME", "FRAMES", "EDITED"]);
            const clock = (ms: number) => {
                const seconds = Math.round(ms / 1000);
                return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
            };
            for (const row of rows) {
                table.push([
                    shortRecordingId(row.id),
                    row.title,
                    formatLocalDateTimeStamp(row.startedAt),
                    row.durationMs === undefined ? (row.movie ? "movie" : "—") : clock(row.durationMs),
                    row.outcome ?? "—",
                    framesCell(row),
                    row.edited ? "yes" : "",
                ]);
            }

            out.println(table.toString());
            out.println(
                "Every command takes the short id; --json has the full ids, folders and why a failed one failed."
            );
        });
}

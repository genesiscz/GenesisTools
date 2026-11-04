import type { WatchSourceId } from "@app/dev-dashboard/contract/watching";
import { formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import { muteWatch, WATCH_SOURCE_IDS, watching } from "../lib/watching/index";

function sourceArg(value: string): WatchSourceId {
    const id = WATCH_SOURCE_IDS.find((source) => source === value);

    if (!id) {
        throw new InvalidArgumentError(`one of ${WATCH_SOURCE_IDS.join(", ")}`);
    }

    return id;
}

function minutesArg(value: string): number {
    const minutes = Number(value);

    if (!Number.isInteger(minutes) || minutes < 0) {
        throw new InvalidArgumentError("whole minutes, 0 lifts the mute");
    }

    return minutes;
}

/**
 * `tools hub watching`: every watch on the Mac in one list (Monitor, domains, shops, TradingView), as the phone's
 * Watching screen shows it (`/api/gateway/watching`), and `tools hub watching mute <source> <id>`, its Mute action.
 */
export function registerWatchingCommand(program: Command): void {
    const command = program
        .command("watching")
        .description("Every watch on the Mac in one list: Monitor, domains, shops and TradingView")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const result = await watching();

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader("Watching", `${result.rows.length} watch(es)`);
            const table = createBoxTable(["SOURCE", "ID", "STATE", "TITLE", "LAST CHANGE", "WHEN"]);
            const now = Date.now();

            for (const row of result.rows) {
                table.push([
                    row.source,
                    truncateDisplay(row.id, 16),
                    row.mutedUntil ? `${row.state} (muted)` : row.state,
                    truncateDisplay(row.title, 28),
                    truncateDisplay(row.detail, 40),
                    row.changedAt ? `${formatDuration(now - Date.parse(row.changedAt))} ago` : "",
                ]);
            }

            out.println(table.toString());

            for (const source of result.sources.filter((entry) => entry.note)) {
                out.log.info(`${source.label}: ${source.note}`);
            }
        });

    command
        .command("mute")
        .description("Silence one watch for a while (Monitor watchers; the other sources have no mute)")
        .argument("<source>", WATCH_SOURCE_IDS.join(", "), sourceArg)
        .argument("<id>", "the row id from tools hub watching")
        .option("--minutes <n>", "how long; 0 lifts the mute", minutesArg, 120)
        .option("--json", "machine-readable output")
        .action(async (source: WatchSourceId, id: string, opts: { minutes: number; json?: boolean }) => {
            const receipt = await muteWatch({ source, id, minutes: opts.minutes });

            if (opts.json) {
                out.result(receipt);
                return;
            }

            out.log.info(receipt.detail);
        });
}

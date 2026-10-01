import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { listLocalCalendar, localAvailable } from "../lib/local";
import { listMcpUpcoming, searchMcpCalendar } from "../lib/mcp";
import { localTime } from "../lib/render";
import type { CalendarEvent, SourceName } from "../lib/types";
import { errorText, fail, parseSource, reportSource, resolveEnum } from "./shared";

const FORMATS = ["table", "json"] as const;
const HOUR_MS = 3_600_000;
/** How far back `calendar search` looks when `--since` is not given. */
const DEFAULT_LOOKBACK_DAYS = 30;

function print(events: CalendarEvent[], source: SourceName, format: (typeof FORMATS)[number]): void {
    reportSource(source);

    if (format === "json") {
        out.result(SafeJSON.stringify({ source, events }, null, 2));
        return;
    }

    const table = createBoxTable(["WHEN", "TITLE", "ATTENDEES"]);

    for (const event of events) {
        table.push([
            `${localTime(event.start)}–${localTime(event.end).slice(11)}`,
            pc.white(truncateDisplay(event.title, 48)),
            truncateDisplay(`${event.attendees.length}: ${event.attendees.slice(0, 3).join(", ")}`, 40),
        ]);
    }

    out.println(table.toString());
    ui.dim(`${events.length} event(s)`);
}

async function load(
    subcommand: string[],
    opts: Record<string, unknown>,
    local: () => CalendarEvent[],
    remote: () => Promise<CalendarEvent[]>
): Promise<void> {
    const source = parseSource(opts.source, subcommand);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: FORMATS,
        flag: "--format",
        subcommand,
    });

    if (!source || !format) {
        return;
    }

    const useLocal = source === "local" || (source === "auto" && localAvailable());

    try {
        print(useLocal ? local() : await remote(), useLocal ? "local" : "mcp", format);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerCalendarCommand(program: Command): void {
    const calendar = program.command("calendar").description("Calendar events Wispr Flow knows about");

    calendar
        .command("upcoming")
        .description("Events in the next hours, soonest first")
        .option("--hours <n>", "window in hours (max 168)", "24")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "table | json")
        .action((opts: Record<string, unknown>) => {
            const hours = Math.min(168, Number(opts.hours ?? 24));
            const now = Date.now();
            return load(
                ["calendar", "upcoming"],
                opts,
                () => listLocalCalendar({ since: now, until: now + hours * HOUR_MS }),
                () => listMcpUpcoming(hours)
            );
        });

    calendar
        .command("search")
        .argument("[query]", "text in the event title")
        .description(`Events by title and time window (default: the last ${DEFAULT_LOOKBACK_DAYS} days)`)
        .option("--since <iso>", "events starting at or after this time")
        .option("--until <iso>", "events starting before this time")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "table | json")
        .action((query: string | undefined, opts: Record<string, unknown>) => {
            const since = opts.since
                ? new Date(String(opts.since)).getTime()
                : Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * HOUR_MS;
            const until = opts.until ? new Date(String(opts.until)).getTime() : Date.now() + 7 * 24 * HOUR_MS;

            if (!Number.isFinite(since) || !Number.isFinite(until)) {
                out.error(
                    `--since and --until take an ISO date or time, got ${String(opts.since ?? "")} ${String(opts.until ?? "")}`.trim()
                );
                process.exitCode = 1;
                return;
            }

            return load(
                ["calendar", "search"],
                opts,
                () => listLocalCalendar({ since, until, query }),
                () =>
                    searchMcpCalendar({
                        query,
                        since: new Date(since).toISOString(),
                        until: new Date(until).toISOString(),
                    })
            );
        });
}

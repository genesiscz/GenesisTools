import { homedir } from "node:os";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { Command } from "commander";
import { loadSpendAccountsContext } from "../accounts-context";
import { loadPricing } from "../config";
import { buildBlocksReport } from "./blocks";
import { isValidTimeZone, parseCostMode, parseDayArg, parseLast, resolveRelativeSince, systemTimeZone } from "./dates";
import { filterEvents, loadEvents } from "./load";
import { buildPeriodReport } from "./period";
import { renderBlocksTable, renderPeriodTable, renderSessionTable } from "./render";
import { buildSessionReport } from "./session";
import { parseStatuslineHook, renderStatusline } from "./statusline";
import type { PeriodGrain, ReportFlags, ReportKind, SourceId } from "./types";
import { SOURCE_REPORTS } from "./types";

const VISUAL_BURN_RATES = ["off", "emoji", "text", "emoji-text"] as const;

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) {
        return "";
    }

    return await new Response(Bun.stdin.stream()).text();
}

function flagsOf(cmd: Command): ReportFlags {
    return cmd.optsWithGlobals() as ReportFlags;
}

function optionFromCli(cmd: Command, key: string): boolean {
    let current: Command | null = cmd;

    while (current) {
        if (current.getOptionValueSource(key) === "cli") {
            return true;
        }

        current = current.parent;
    }

    return false;
}

export function addReportFlags(
    cmd: Command,
    options: { last?: boolean; breakdown?: boolean; mode?: boolean; blocks?: boolean; sessionId?: boolean }
): Command {
    cmd.option("-j, --json", "Emit the report as JSON to stdout");
    cmd.option("-s, --since <since>", "Filter from date (YYYY-MM-DD or YYYYMMDD)");
    cmd.option("-u, --until <until>", "Filter until date (inclusive)");
    cmd.option("-z, --timezone <timezone>", "Timezone for date grouping (IANA)");

    if (options.last) {
        cmd.option("--last <last>", "Show only the most recent N periods");
    }

    if (options.breakdown) {
        cmd.option("-b, --breakdown", "Show per-model cost breakdown");
    }

    if (options.mode) {
        cmd.option("-m, --mode [mode]", "Cost calculation mode (auto | calculate | display)");
    }

    if (options.sessionId) {
        cmd.option("-i, --id <id>", "Filter to a specific session ID");
    }

    if (options.blocks) {
        cmd.option("-a, --active", "Show only the active block with projections");
        cmd.option("-r, --recent", "Show blocks from the last 3 days (including active)");
        cmd.option("-n, --session-length [session-length]", "Session block duration in hours", "5");
    }

    cmd.option("--by-agent", "Include per-agent JSON breakdowns in unified rows");
    addAccountFlags(cmd);
    return cmd;
}

/**
 * The account dimension, on every door that reads transcripts.
 *
 * `monitor` and `series` declare the same two flags. A behaviour reachable
 * through one command and not another is the defect this campaign exists to
 * remove, so these are added in one place and used in three.
 */
export function addAccountFlags(cmd: Command): Command {
    cmd.option("--all-homes", "Also read provider homes on disk that no account is bound to");
    cmd.option("--account <id...>", 'Report only these account ids ("(unbound)" and "claude-all" allowed)');
    return cmd;
}

function addStatuslineFlags(cmd: Command): Command {
    cmd.option("-z, --timezone <timezone>", "Timezone for date grouping (IANA)");
    cmd.option("-m, --mode [mode]", "Cost calculation mode (auto | calculate | display)");
    cmd.option(
        "-B, --visual-burn-rate [visual-burn-rate]",
        "Burn-rate visualization (off | emoji | text | emoji-text)"
    );
    return cmd;
}

function parseVisualBurnRate(raw: string | boolean | undefined): (typeof VISUAL_BURN_RATES)[number] | undefined {
    if (raw === undefined) {
        return "off";
    }

    if (raw === true || raw === "") {
        return "emoji";
    }

    if (typeof raw === "string" && (VISUAL_BURN_RATES as readonly string[]).includes(raw)) {
        return raw as (typeof VISUAL_BURN_RATES)[number];
    }

    return undefined;
}

async function runReport(cmd: Command, kind: ReportKind, source?: SourceId): Promise<void> {
    const flags = flagsOf(cmd);

    if (flags.mode !== undefined) {
        const raw = typeof flags.mode === "string" ? flags.mode : "";
        if (raw !== "auto" && raw !== "calculate" && raw !== "display") {
            process.stderr.write(`${suggestEnumFlag("tools ai-spend", "--mode", ["auto", "calculate", "display"])}\n`);
            process.exitCode = 1;
            return;
        }
    }

    const timezoneRaw = flags.timezone?.trim();
    if (timezoneRaw && !isValidTimeZone(timezoneRaw)) {
        process.stderr.write(`Invalid --timezone ${timezoneRaw}. Use an IANA timezone name.\n`);
        process.exitCode = 1;
        return;
    }

    const timezone = timezoneRaw || systemTimeZone();
    const home = homedir();
    const now = new Date();
    const storage = new Storage("ai-spend");
    const pricing = await loadPricing(storage);
    const mode = parseCostMode(typeof flags.mode === "string" ? flags.mode : undefined);
    const sources = source ? ([source] as const) : undefined;
    const sincePassed = optionFromCli(cmd, "since");
    const untilPassed = optionFromCli(cmd, "until");
    const sinceRaw = sincePassed ? flags.since : undefined;
    const untilRaw = untilPassed ? flags.until : undefined;
    const sinceDay = sinceRaw ? (parseDayArg(sinceRaw) ?? resolveRelativeSince(sinceRaw, now, timezone)) : undefined;
    const untilDay = untilRaw ? parseDayArg(untilRaw) : undefined;

    if (sinceRaw && !sinceDay) {
        process.stderr.write(`Invalid --since ${sinceRaw}. Use YYYY-MM-DD, YYYYMMDD, or Nd.\n`);
        process.exitCode = 1;
        return;
    }

    if (untilRaw && !untilDay) {
        process.stderr.write(`Invalid --until ${untilRaw}. Use YYYY-MM-DD or YYYYMMDD.\n`);
        process.exitCode = 1;
        return;
    }
    let minMtimeMs = sinceDay ? Date.parse(`${sinceDay}T00:00:00.000Z`) - 3 * 24 * 60 * 60 * 1000 : 0;

    if (kind === "statusline" && !sinceDay) {
        minMtimeMs = now.getTime() - 2 * 24 * 60 * 60 * 1000;
    }

    const context = await loadSpendAccountsContext({ allHomes: flags.allHomes });
    const loaded = loadEvents({
        home,
        sources,
        minMtimeMs: Number.isFinite(minMtimeMs) ? minMtimeMs : 0,
        accounts: context.accounts,
        discoveredHomes: context.discoveredHomes,
    });
    // Filtering here rather than inside each report builder: `--account` means
    // the same thing for daily, session and blocks, and the builders each own a
    // frozen ccusage-compatible row shape that must not learn a new dimension.
    const events = flags.account ? filterEvents(loaded, { timezone, accountIds: flags.account }) : loaded;

    if (kind === "statusline") {
        const stdin = await readStdin();
        const hook = parseStatuslineHook(stdin);

        if (!hook) {
            process.stderr.write("No input provided. Pipe Claude Code hook JSON on stdin.\n");
            process.exitCode = 1;
            return;
        }

        const visual = parseVisualBurnRate(flags.visualBurnRate);
        if (!visual) {
            process.stderr.write(`${suggestEnumFlag("tools ai-spend", "--visual-burn-rate", VISUAL_BURN_RATES)}\n`);
            process.exitCode = 1;
            return;
        }

        const line = renderStatusline(
            hook,
            events.filter((event) => event.source === "claude"),
            {
                timezone,
                now,
                pricing,
                mode,
                costSource: "auto",
                visualBurnRate: visual,
            }
        );
        out.print(`${line}\n`);
        return;
    }

    if (kind === "blocks") {
        const hours = flags.sessionLength ? Number.parseFloat(flags.sessionLength) : 5;
        const report = buildBlocksReport(
            events.filter((event) => event.source === "claude"),
            {
                timezone,
                sinceDay,
                untilDay,
                now,
                pricing,
                mode,
                active: flags.active,
                recent: flags.recent,
                sessionHours: Number.isFinite(hours) ? hours : 5,
            }
        );

        if (flags.json) {
            out.result(report);
            return;
        }

        out.println(renderBlocksTable(report, Boolean(flags.breakdown)));
        return;
    }

    const last = parseLast(flags.last);
    const common = {
        timezone,
        sinceDay,
        untilDay,
        last,
        now,
        pricing,
        mode,
        source,
        byAgent: Boolean(flags.byAgent),
    };

    if (kind === "session") {
        const report = buildSessionReport(events, { ...common, sessionId: flags.id });

        if (flags.json) {
            out.result(report);
            return;
        }

        out.println(renderSessionTable(report, Boolean(flags.breakdown)));
        return;
    }

    const grain = kind as PeriodGrain;
    const report = buildPeriodReport(events, { ...common, grain });

    if (flags.json) {
        out.result(report);
        return;
    }

    out.println(renderPeriodTable(report, grain, Boolean(flags.breakdown)));
}

export function registerCcusageCommands(program: Command): void {
    const periodKinds: PeriodGrain[] = ["daily", "weekly", "monthly"];

    for (const grain of periodKinds) {
        addReportFlags(program.command(grain).description(`Show all detected coding-agent usage grouped by ${grain}`), {
            last: true,
            breakdown: true,
        }).action(async (_opts: ReportFlags, cmd: Command) => {
            await runReport(cmd, grain);
        });
    }

    addReportFlags(program.command("session").description("Show all detected coding-agent usage grouped by session"), {
        breakdown: true,
        sessionId: true,
    }).action(async (_opts: ReportFlags, cmd: Command) => {
        await runReport(cmd, "session");
    });

    addReportFlags(program.command("blocks").description("Show usage grouped by 5-hour Claude Code billing windows"), {
        breakdown: true,
        mode: true,
        blocks: true,
    }).action(async (_opts: ReportFlags, cmd: Command) => {
        await runReport(cmd, "blocks");
    });

    addStatuslineFlags(
        program.command("statusline").description("Compact Claude Code hook status line (reads hook JSON from stdin)")
    ).action(async (_opts: ReportFlags, cmd: Command) => {
        await runReport(cmd, "statusline");
    });

    for (const [source, reports] of Object.entries(SOURCE_REPORTS) as Array<[SourceId, readonly ReportKind[]]>) {
        const parent = program.command(source).description(`Show ${source} usage commands`);

        for (const kind of reports) {
            if (kind === "statusline") {
                addStatuslineFlags(
                    parent
                        .command("statusline")
                        .description("Compact Claude Code hook status line (reads hook JSON from stdin)")
                ).action(async (_opts: ReportFlags, cmd: Command) => {
                    await runReport(cmd, "statusline", source);
                });
                continue;
            }

            const extra = {
                last: kind === "daily" || kind === "weekly" || kind === "monthly",
                breakdown: true,
                mode: source === "claude",
                blocks: kind === "blocks",
                sessionId: kind === "session",
            };
            addReportFlags(parent.command(kind).description(`${source} ${kind} report`), extra).action(
                async (_opts: ReportFlags, cmd: Command) => {
                    await runReport(cmd, kind, source);
                }
            );
        }
    }
}

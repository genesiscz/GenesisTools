import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { Command } from "commander";
import { loadSpendAccountsContext } from "./accounts-context";
import { aggregate } from "./aggregate";
import { loadPricing } from "./config";
import { AGENT_IDS } from "./drivers";
import { buildMonitorReport, type MonitorReport } from "./monitor";
import { prof } from "./prof";
import { renderSessions, renderSummary, renderToday } from "./render";
import { addAccountFlags, registerCcusageCommands } from "./reports/commands";
import { eventCostEstimate } from "./reports/cost";
import { candidatesFor } from "./reports/load";
import { loadEventsParallel } from "./reports/load-parallel";
import { SOURCE_IDS, type SourceId, type SpendEvent } from "./reports/types";
import { buildSpendSeries, type TranscriptGrain } from "./series";
import { resolveSince } from "./since";
import type { PricingTable, Report, UsageEvent } from "./types";

/** Grains `buildSpendSeries` accepts. `minute` is call-log only. */
const TRANSCRIPT_GRAINS: readonly TranscriptGrain[] = ["hour", "day", "week"];

export interface SpendOpts {
    since?: string;
    model?: string;
    project?: string;
    top?: string;
    json?: boolean;
    sources?: string;
}

export type SpendView = "summary" | "sessions" | "today";

const DEFAULT_SINCE = "30d";

/**
 * `aggregate` predates the ccusage reports and speaks its own event shape. The
 * two differ in the id field and in how cost is carried, so bridging beats
 * forking the aggregator — which is what kept `discover.ts` alive as a second
 * discovery stack that missed `~/.config/claude/projects` and `CLAUDE_CONFIG_DIR`.
 */
export function toUsageEvent(event: SpendEvent, pricing: PricingTable): UsageEvent {
    // Priced like the ccusage reports: a recorded charge wins, then the source's own candidate
    // ladder and service tier. Grok records `costUsdTicks` and is in no rate table, so without this it reads $0.
    const estimate = eventCostEstimate(event, pricing, "auto", candidatesFor(event));

    return {
        // The loader keeps the same id from two sources apart, so the aggregator must too.
        messageId: `${event.source}:${event.id}`,
        model: event.model,
        timestamp: event.timestamp,
        project: event.project,
        sessionId: event.sessionId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
        costUsd: estimate.costUSD ?? undefined,
    };
}

/** Oldest transcript mtime that can still hold an event on `sinceDay`, with the same 3-day margin as the ccusage reports. */
export function transcriptCutoffMs(sinceDay: string | undefined): number {
    if (!sinceDay) {
        return 0;
    }

    const start = Date.parse(`${sinceDay}T00:00:00.000Z`);

    return Number.isFinite(start) ? start - 3 * 24 * 60 * 60 * 1000 : 0;
}

async function buildReport(opts: SpendOpts, view: SpendView, sources: SourceId[] | undefined): Promise<Report> {
    const now = new Date();
    const storage = new Storage("ai-spend");
    const pricing = await prof.measureAsync("pricing", () => loadPricing(storage));

    let sinceDay: string | undefined;
    if (view === "today") {
        sinceDay = now.toISOString().slice(0, 10);
    } else {
        sinceDay = resolveSince(opts.since ?? DEFAULT_SINCE, now) ?? resolveSince(DEFAULT_SINCE, now);
    }

    // Transcripts are append-only, so one last written before the window cannot hold an event inside
    // it. Without this the report parsed every transcript ever written (14 s on 16 GB of history),
    // blocking the event loop the whole time.
    const loaded = await prof.measureAsync("load-events", () =>
        loadEventsParallel({ home: homedir(), sources, minMtimeMs: transcriptCutoffMs(sinceDay) })
    );
    const events = loaded.map((event) => toUsageEvent(event, pricing));

    const parsedTop = opts.top ? Number.parseInt(opts.top, 10) : 10;
    const top = Number.isInteger(parsedTop) && parsedTop > 0 ? parsedTop : 10;
    return prof.measure("aggregate", () =>
        aggregate({ events, pricing, now, sinceDay, model: opts.model, project: opts.project, top })
    );
}

function emit(report: Report, opts: SpendOpts, view: SpendView): void {
    if (opts.json) {
        out.result(report);
        return;
    }

    if (view === "sessions") {
        out.println(renderSessions(report));
        return;
    }

    if (view === "today") {
        out.println(renderToday(report));
        return;
    }

    out.println(renderSummary(report));
}

export function addSpendOptions(cmd: Command): Command {
    return cmd
        .option("--since <when>", 'Include events on/after "Nd" or YYYY-MM-DD', DEFAULT_SINCE)
        .option("--model <substr>", "Filter to models containing this substring")
        .option("--project <substr>", "Filter to projects (cwd) containing this substring")
        .option("--top <n>", "Leaderboard length", "10")
        .option("--sources <ids>", `Comma-separated subset of ${SOURCE_IDS.join(", ")} (default: all)`)
        .option("--json", "Emit the Report as JSON to stdout");
}

export async function runSpend(cmd: Command, view: SpendView): Promise<void> {
    // Shared options live on BOTH the root program and each subcommand, so
    // commander treats them as global. The action's plain opts arg therefore
    // omits flags resolved onto the parent — optsWithGlobals() merges them back.
    const opts = cmd.optsWithGlobals() as SpendOpts;
    const sources = parseSources(opts.sources, { command: view, ids: SOURCE_IDS });

    if (sources === null) {
        return;
    }

    const report = await buildReport(opts, view, sources);
    prof.measure("render", () => emit(report, opts, view));
    prof.summary("ai-spend report");
}

/**
 * The `monitor --json` envelope.
 *
 * 🛑 `today.cost`, `today.tokens`, `week.cost`, `week.tokens` are decoded
 * STRICTLY by the Genesis app's `SpendClient`. They must stay numbers at these
 * exact paths; extra keys are ignored by its `JSONDecoder`, so `accounts` may
 * ride alongside, but nothing may move cost into a new top-level key.
 */
export function monitorEnvelope(report: MonitorReport): Record<string, unknown> {
    const envelope: Record<string, unknown> = {
        today: report.today,
        yesterday: report.yesterday,
        week: report.week,
        last7d: report.last7d,
        todayDate: report.todayDate,
        yesterdayDate: report.yesterdayDate,
        weekStart: report.weekStart,
        last7dStart: report.last7dStart,
        timezone: report.timezone,
        agents: report.agents,
    };

    if (report.accounts) {
        envelope.accounts = report.accounts;
    }

    return envelope;
}

interface SeriesOpts {
    from?: string;
    to?: string;
    grain?: string | true;
    account?: string[];
    allHomes?: boolean;
    sources?: string;
    byModel?: boolean;
    json?: boolean;
}

interface MonitorOpts {
    json?: boolean;
    allHomes?: boolean;
    account?: string[];
}

const SERIES_DEFAULT_DAYS = 7;

/**
 * `null` means "rejected, diagnostic already printed" and the action returns.
 *
 * Throwing instead would reach `runTool`'s uncaught `program.parseAsync()`, so a
 * mistyped `--sources` printed a Bun stack trace with a source excerpt where a
 * one-line flag diagnostic belongs.
 */
function parseSources<T extends string>(
    raw: string | undefined,
    { command, ids }: { command: string; ids: readonly T[] }
): T[] | undefined | null {
    if (!raw) {
        return undefined;
    }

    const wanted = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    const known = (value: string): value is T => (ids as readonly string[]).includes(value);
    const unknown = wanted.filter((value) => !known(value));

    if (unknown.length > 0) {
        out.error(
            suggestEnumFlag(`tools ai-spend ${command}`, "--sources", ids, {
                subcommand: [command],
                given: unknown.join(", "),
            })
        );
        process.exitCode = 1;

        return null;
    }

    return wanted.filter(known);
}

async function resolveGrain(raw: string | true | undefined): Promise<TranscriptGrain | null> {
    if (typeof raw === "string" && (TRANSCRIPT_GRAINS as readonly string[]).includes(raw)) {
        return raw as TranscriptGrain;
    }

    // Enumerated flag: commander's own "argument missing" never lists the values,
    // so the flag is declared optional and the empty case is handled here.
    //
    // A value that is PRESENT but wrong is not a missing value. Prompting for it
    // would swallow the typo and then exit 0 as though `--grain bad` had been
    // honoured, so only an omitted or bare `--grain` reaches the prompt.
    const given = typeof raw === "string" && raw.length > 0 ? raw : undefined;

    if (given !== undefined || !isInteractive()) {
        out.error(
            suggestEnumFlag("tools ai-spend series", "--grain", TRANSCRIPT_GRAINS, {
                subcommand: ["series"],
                given,
            })
        );
        process.exitCode = 1;

        return null;
    }

    const picked = await p.select({
        message: "Bucket width",
        options: TRANSCRIPT_GRAINS.map((value) => ({ value, label: value })),
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked;
}

function renderSeries(result: Awaited<ReturnType<typeof buildSpendSeries>>): string {
    if (result.points.length === 0) {
        return "no transcript spend in that window";
    }

    const names = new Map(result.accounts.map((account) => [account.accountId, account.accountName]));
    const lines = result.points.map((point) => {
        const split = Object.entries(point.byAccount)
            .map(([id, bucket]) => `${names.get(id) ?? id} $${bucket.costUsd.toFixed(2)}`)
            .join(" · ");

        return `${point.t}  $${point.costUsd.toFixed(2)}  ${point.tokens.toLocaleString()} tok  ${split}`;
    });

    if (result.unpriced > 0) {
        lines.push(`${result.unpriced} event(s) had no known rate — their cost is missing, not zero`);
    }

    return lines.join("\n");
}

function registerSeriesCommand(program: Command): Command {
    const series = program
        .command("series")
        .description("Transcript spend over time, bucketed and split by account")
        .option("--from <when>", `ISO instant or YYYY-MM-DD (default: ${SERIES_DEFAULT_DAYS} days ago)`)
        .option("--to <when>", "ISO instant or YYYY-MM-DD, exclusive (default: now)")
        .option("--grain [width]", `Bucket width: ${TRANSCRIPT_GRAINS.join(" | ")}`)
        .option("--sources <ids>", `Comma-separated subset of ${AGENT_IDS.join(", ")}`)
        .option("--by-model", "Also split each point by model");

    addAccountFlags(series).action(async (_opts: SeriesOpts, cmd: Command) => {
        const opts = cmd.optsWithGlobals() as SeriesOpts;
        // Ahead of the grain prompt: a mistyped --sources must not sit behind an
        // interactive question the user then answers for nothing.
        const sources = parseSources(opts.sources, { command: "series", ids: AGENT_IDS });

        if (sources === null) {
            return;
        }

        const grain = await resolveGrain(opts.grain);

        if (!grain) {
            return;
        }

        const now = new Date();
        const from = opts.from ?? new Date(now.getTime() - SERIES_DEFAULT_DAYS * 86_400_000).toISOString();
        const context = await prof.measureAsync("series:accounts", () =>
            loadSpendAccountsContext({ allHomes: opts.allHomes })
        );
        const result = await prof.measureAsync("series:build", () =>
            buildSpendSeries(
                {
                    from,
                    to: opts.to ?? now.toISOString(),
                    grain,
                    sources,
                    accountIds: opts.account,
                    byModel: opts.byModel,
                },
                { accounts: context.accounts, discoveredHomes: context.discoveredHomes }
            )
        );

        if (opts.json) {
            out.result(result);
            prof.summary("ai-spend series");

            return;
        }

        out.println(renderSeries(result));
        prof.summary("ai-spend series");
    });

    return program;
}

export function registerSpendCommand(program: Command): Command {
    addSpendOptions(program).action(async (_opts: SpendOpts, cmd: Command) => {
        await runSpend(cmd, "summary");
    });

    addSpendOptions(program.command("summary").description("Spend summary for the window (default)")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "summary");
        }
    );

    addSpendOptions(program.command("sessions").description("Most expensive sessions leaderboard")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "sessions");
        }
    );

    addSpendOptions(program.command("today").description("Today's spend (UTC day)")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "today");
        }
    );

    registerCcusageCommands(program);
    registerSeriesCommand(program);

    const monitor = program
        .command("monitor")
        .description(
            "Today, yesterday, current week (local timezone, Monday start) and last 7 days across claude/codex/grok in <1s — for status bars/monitors"
        )
        .option(
            "--json",
            "Emit {today, yesterday, week, last7d, todayDate, yesterdayDate, weekStart, last7dStart, timezone, agents, accounts} as JSON"
        );

    addAccountFlags(monitor).action(async (_opts: MonitorOpts, cmd: Command) => {
        // Root also defines --json (addSpendOptions), so commander binds it there;
        // optsWithGlobals() merges it back — same as runSpend above.
        const opts = cmd.optsWithGlobals() as MonitorOpts;
        const storage = new Storage("ai-spend");
        const pricing = await prof.measureAsync("pricing", () => loadPricing(storage));
        const context = await prof.measureAsync("monitor:accounts", () =>
            loadSpendAccountsContext({ allHomes: opts.allHomes })
        );
        const report = prof.measure("monitor:build", () =>
            buildMonitorReport({
                pricing,
                storage,
                accounts: context.accounts,
                discoveredHomes: context.discoveredHomes,
                accountIds: opts.account,
            })
        );
        prof.summary("ai-spend monitor");

        if (opts.json) {
            out.result(monitorEnvelope(report));

            return;
        }

        const perAgent = AGENT_IDS.filter((id) => report.agents[id].week.tokens > 0)
            .map((id) => `${id} $${report.agents[id].today.cost.toFixed(2)}`)
            .join(" · ");
        const perAccount = (report.accounts ?? [])
            .filter((account) => account.today.tokens > 0)
            .map((account) => `${account.accountName} $${account.today.cost.toFixed(2)}`)
            .join(" · ");

        out.println(
            `today ${report.todayDate}: $${report.today.cost.toFixed(2)} (${report.today.tokens.toLocaleString()} tok)\n` +
                `yesterday ${report.yesterdayDate}: $${report.yesterday.cost.toFixed(2)} (${report.yesterday.tokens.toLocaleString()} tok)\n` +
                `week from ${report.weekStart}: $${report.week.cost.toFixed(2)} (${report.week.tokens.toLocaleString()} tok)\n` +
                `last 7 days from ${report.last7dStart}: $${report.last7d.cost.toFixed(2)} (${report.last7d.tokens.toLocaleString()} tok) [${report.timezone}]` +
                (perAgent ? `\ntoday by agent: ${perAgent}` : "") +
                (perAccount ? `\ntoday by account: ${perAccount}` : "")
        );
    });

    return program;
}

import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { Command } from "commander";
import { aggregate } from "./aggregate";
import { loadPricing } from "./config";
import { findTranscriptFiles, readEvents } from "./discover";
import { AGENT_IDS, type AgentId } from "./drivers";
import { buildMonitorReport, type MonitorReport } from "./monitor";
import { renderSessions, renderSummary, renderToday } from "./render";
import { registerCcusageCommands } from "./reports/commands";
import { buildSpendSeries, type TranscriptGrain } from "./series";
import { resolveSince } from "./since";
import type { Report } from "./types";

/** Grains `buildSpendSeries` accepts. `minute` is call-log only. */
const TRANSCRIPT_GRAINS: readonly TranscriptGrain[] = ["hour", "day", "week"];

export interface SpendOpts {
    since?: string;
    model?: string;
    project?: string;
    top?: string;
    json?: boolean;
}

export type SpendView = "summary" | "sessions" | "today";

const DEFAULT_SINCE = "30d";

async function buildReport(opts: SpendOpts, view: SpendView): Promise<Report> {
    const now = new Date();
    const storage = new Storage("ai-spend");
    const pricing = await loadPricing(storage);
    const events = readEvents(findTranscriptFiles(homedir()));

    let sinceDay: string | undefined;
    if (view === "today") {
        sinceDay = now.toISOString().slice(0, 10);
    } else {
        sinceDay = resolveSince(opts.since ?? DEFAULT_SINCE, now) ?? resolveSince(DEFAULT_SINCE, now);
    }

    const parsedTop = opts.top ? Number.parseInt(opts.top, 10) : 10;
    const top = Number.isInteger(parsedTop) && parsedTop > 0 ? parsedTop : 10;
    return aggregate({ events, pricing, now, sinceDay, model: opts.model, project: opts.project, top });
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
        .option("--json", "Emit the Report as JSON to stdout");
}

export async function runSpend(cmd: Command, view: SpendView): Promise<void> {
    // Shared options live on BOTH the root program and each subcommand, so
    // commander treats them as global. The action's plain opts arg therefore
    // omits flags resolved onto the parent — optsWithGlobals() merges them back.
    const opts = cmd.optsWithGlobals() as SpendOpts;
    emit(await buildReport(opts, view), opts, view);
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
        week: report.week,
        todayDate: report.todayDate,
        weekStart: report.weekStart,
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
    sources?: string;
    byModel?: boolean;
    json?: boolean;
}

const SERIES_DEFAULT_DAYS = 7;

function parseSources(raw: string | undefined): AgentId[] | undefined {
    if (!raw) {
        return undefined;
    }

    const wanted = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    const unknown = wanted.filter((value) => !AGENT_IDS.includes(value as AgentId));

    if (unknown.length > 0) {
        throw new Error(`unknown --sources value(s): ${unknown.join(", ")}. Known: ${AGENT_IDS.join(", ")}`);
    }

    return wanted as AgentId[];
}

async function resolveGrain(raw: string | true | undefined): Promise<TranscriptGrain | null> {
    if (typeof raw === "string" && (TRANSCRIPT_GRAINS as readonly string[]).includes(raw)) {
        return raw as TranscriptGrain;
    }

    // Enumerated flag: commander's own "argument missing" never lists the values,
    // so the flag is declared optional and the empty case is handled here.
    if (!isInteractive()) {
        out.error(suggestEnumFlag("tools ai-spend series", "--grain", TRANSCRIPT_GRAINS, { subcommand: ["series"] }));
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
    program
        .command("series")
        .description("Transcript spend over time, bucketed and split by account")
        .option("--from <when>", `ISO instant or YYYY-MM-DD (default: ${SERIES_DEFAULT_DAYS} days ago)`)
        .option("--to <when>", "ISO instant or YYYY-MM-DD, exclusive (default: now)")
        .option("--grain [width]", `Bucket width: ${TRANSCRIPT_GRAINS.join(" | ")}`)
        .option("--account <id...>", 'Filter to these account ids ("(unbound)" and "claude-all" allowed)')
        .option("--sources <ids>", `Comma-separated subset of ${AGENT_IDS.join(", ")}`)
        .option("--by-model", "Also split each point by model")
        .action(async (_opts: SeriesOpts, cmd: Command) => {
            const opts = cmd.optsWithGlobals() as SeriesOpts;
            const grain = await resolveGrain(opts.grain);

            if (!grain) {
                return;
            }

            const now = new Date();
            const from = opts.from ?? new Date(now.getTime() - SERIES_DEFAULT_DAYS * 86_400_000).toISOString();
            const result = await buildSpendSeries({
                from,
                to: opts.to ?? now.toISOString(),
                grain,
                sources: parseSources(opts.sources),
                accountIds: opts.account,
                byModel: opts.byModel,
            });

            if (opts.json) {
                out.result(result);

                return;
            }

            out.println(renderSeries(result));
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

    program
        .command("monitor")
        .description(
            "Today + current week (local timezone, Monday start) across claude/codex/grok in <1s — for status bars/monitors"
        )
        .option("--json", "Emit {today, week, todayDate, weekStart, timezone, agents} as JSON")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
            // Root also defines --json (addSpendOptions), so commander binds it there;
            // optsWithGlobals() merges it back — same as runSpend above.
            const opts = cmd.optsWithGlobals() as { json?: boolean };
            const storage = new Storage("ai-spend");
            const pricing = await loadPricing(storage);
            const report = buildMonitorReport({ pricing, storage });

            if (opts.json) {
                out.result(monitorEnvelope(report));

                return;
            }

            const perAgent = AGENT_IDS.filter((id) => report.agents[id].week.tokens > 0)
                .map((id) => `${id} $${report.agents[id].today.cost.toFixed(2)}`)
                .join(" · ");

            out.println(
                `today ${report.todayDate}: $${report.today.cost.toFixed(2)} (${report.today.tokens.toLocaleString()} tok)\n` +
                    `week from ${report.weekStart}: $${report.week.cost.toFixed(2)} (${report.week.tokens.toLocaleString()} tok) [${report.timezone}]` +
                    (perAgent ? `\ntoday by agent: ${perAgent}` : "")
            );
        });

    return program;
}

import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { formatDuration, parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { describeAncestry } from "./caller";
import {
    callsDbPath,
    computeStats,
    listCalls,
    NO_OUTCOME_AFTER_MS,
    openCallsDb,
    type SayCallRecord,
    type SayCallStats,
} from "./calls";

const { log } = logger.scoped("say:calls-view");

const CMUX_TIMEOUT_MS = 1500;
const SPARK = "▁▂▃▄▅▆▇█";

export interface LogsOptions {
    limit: number;
    attention?: boolean;
    grep?: string;
    since?: string;
    json?: boolean;
    full?: boolean;
}

export interface StatsViewOptions {
    since?: string;
    json?: boolean;
}

/**
 * `--since` accepts a duration (`7d`, `24h`, `90m`, `1h30m`) or a date (`2026-09-15`,
 * ISO datetime). Returns null when the value cannot be read.
 */
export function parseSince(raw: string | undefined, now = Date.now()): number | null | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw.trim();

    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        const parsed = Date.parse(trimmed);
        return Number.isNaN(parsed) ? null : parsed;
    }

    const ms = parseDuration(trimmed);

    return ms > 0 ? now - ms : null;
}

interface WindowRpc {
    id?: string;
    index?: number;
}

interface WorkspaceListRpc {
    workspaces?: { id?: string; title?: string; custom_title?: string; name?: string }[];
}

/**
 * cmux workspace id → its current title, for every window. Best effort: without a
 * running cmux the map stays empty and the view shows short ids instead.
 */
export async function resolveWorkspaceNames(ids: Iterable<string>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const wanted = new Set([...ids].map((id) => id.toLowerCase()));

    if (wanted.size === 0) {
        return names;
    }

    try {
        const windows = await runCmuxJSON<WindowRpc[]>(["list-windows"], { timeoutMs: CMUX_TIMEOUT_MS });
        const lists = await Promise.all(
            windows.map((w) =>
                runCmuxJSON<WorkspaceListRpc>(["list-workspaces", "--window", w.id ?? String(w.index ?? 0)], {
                    timeoutMs: CMUX_TIMEOUT_MS,
                })
            )
        );

        for (const list of lists) {
            for (const workspace of list.workspaces ?? []) {
                const id = workspace.id?.toLowerCase();
                const name = workspace.custom_title || workspace.title || workspace.name;

                if (id && name && wanted.has(id)) {
                    names.set(id, name);
                }
            }
        }
    } catch (err) {
        log.debug({ err }, "cmux workspace names unavailable; showing ids");
    }

    return names;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function formatWhen(ts: number, now: number): string {
    const date = new Date(ts);
    const today = new Date(now);
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

    if (date.toDateString() === today.toDateString()) {
        return time;
    }

    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function formatFullWhen(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function dayOf(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function agentLabel(agent: string): string {
    switch (agent) {
        case "claude-code":
            return "claude";
        case "unknown":
            return "—";
        default:
            return agent;
    }
}

function whereLabel(record: SayCallRecord, names: Map<string, string>, max: number): string {
    const c = record.caller;

    if (c.workspaceId) {
        const name = names.get(c.workspaceId.toLowerCase());
        return truncateDisplay(name ?? c.workspaceId.slice(0, 8), max);
    }

    if (c.tmuxPane) {
        return `tmux ${c.tmuxPane}`;
    }

    return truncateDisplay(c.termProgram, max);
}

function statusCell(record: SayCallRecord, now: number): string {
    switch (record.status) {
        case "spoken":
            return formatDotStatus("ok", "spoken");
        case "written":
            return formatDotStatus("ok", "written");
        case "muted":
            return formatDotStatus("dim", "muted");
        case "failed":
            return formatDotStatus("err", "failed");
        case "started":
            return now - record.ts < NO_OUTCOME_AFTER_MS
                ? formatDotStatus("dim", "playing")
                : formatDotStatus("warn", "no outcome");
    }
}

function textCell(record: SayCallRecord, max: number): string {
    if (record.attention) {
        return pc.yellow(pc.bold(`❗ ${truncateDisplay(record.text, max - 2)}`));
    }

    return truncateDisplay(record.text, max);
}

function speechLabel(record: SayCallRecord): string {
    const parts: string[] = [];

    if (record.provider) {
        parts.push(record.voice ? `${record.provider}/${record.voice}` : record.provider);
    }

    if (record.cacheHit) {
        parts.push("cache hit");
    }

    if (record.fallbackFrom) {
        parts.push(`fell back from ${record.fallbackFrom}`);
    }

    if (record.finishedAt !== null) {
        parts.push(`${formatDuration(record.finishedAt - record.ts)} to finish`);
    }

    return parts.length > 0 ? parts.join(" · ") : "—";
}

function renderLogsTable(records: SayCallRecord[], names: Map<string, string>, now: number): void {
    const table = createBoxTable(["WHEN", "AGENT", "SESSION", "WHERE", "APP", "PROVIDER", "STATUS", "TEXT"]);

    for (const record of records) {
        table.push([
            pc.white(formatWhen(record.ts, now)),
            agentLabel(record.caller.agent),
            record.caller.sessionId ? pc.magenta(record.caller.sessionId.slice(0, 8)) : pc.dim("—"),
            whereLabel(record, names, 22),
            truncateDisplay(record.app, 10),
            truncateDisplay(record.provider, 8),
            statusCell(record, now),
            textCell(record, 56),
        ]);
    }

    out.println(table.toString());
}

function renderCallDetail(record: SayCallRecord, names: Map<string, string>, now: number): void {
    const c = record.caller;
    const heading = `${formatFullWhen(record.ts)}  ${statusCell(record, now)}  ${pc.dim(record.id)}`;

    out.println(pc.bold(heading));
    renderCliKeyRow("text", record.attention ? pc.yellow(pc.bold(`❗ ${record.text}`)) : pc.white(record.text));
    renderCliKeyRow(
        "argv",
        pc.dim(record.argv.map((arg) => (/\s/.test(arg) ? SafeJSON.stringify(arg) : arg)).join(" "))
    );
    renderCliKeyRow(
        "agent",
        `${agentLabel(c.agent)}  session ${c.sessionId ? pc.magenta(c.sessionId) : "—"}  account ${c.account ?? "—"}  ${pc.dim(c.aiAgent ?? "")}`
    );

    if (c.workspaceId || c.surfaceId) {
        const name = c.workspaceId ? names.get(c.workspaceId.toLowerCase()) : undefined;
        renderCliKeyRow(
            "cmux",
            `workspace ${name ? `${pc.white(name)} ` : ""}${pc.dim(c.workspaceId ?? "—")}  surface ${pc.dim(c.surfaceId ?? "—")}  tab ${pc.dim(c.tabId ?? "—")}`
        );
    } else if (c.tmuxPane) {
        renderCliKeyRow("tmux", `pane ${c.tmuxPane}  ${pc.dim(c.termProgram ?? "")}`);
    } else {
        renderCliKeyRow("terminal", c.termProgram ?? "—");
    }

    renderCliKeyRow("cwd", pc.dim(c.cwd));
    renderCliKeyRow("via", describeAncestry(c.ancestry) || pc.dim("—"));
    renderCliKeyRow("speech", speechLabel(record));
    renderCliKeyRow("pids", `say ${record.pid} · speaker ${record.speakerPid ?? "—"} · shell ${c.callerPid}`);
    renderCliKeyRow(
        "day log",
        pc.dim(`rg '"pid":${record.speakerPid ?? record.pid}' ~/.genesis-tools/logs/${dayOf(record.ts)}.log`)
    );

    if (c.sessionId) {
        renderCliKeyRow("jump", pc.dim(`tools claude cmux focus ${c.sessionId.slice(0, 8)}`));
    }

    if (record.error) {
        renderCliKeyRow("error", pc.red(record.error));
    }

    out.println();
}

function describeFilters(opts: { attention?: boolean; grep?: string; since?: string }): string {
    const parts: string[] = [];

    if (opts.since) {
        parts.push(`since ${opts.since}`);
    }

    if (opts.attention) {
        parts.push("attention only");
    }

    if (opts.grep) {
        parts.push(`text contains "${opts.grep}"`);
    }

    return parts.join(" · ");
}

function rejectSince(raw: string): void {
    out.error(pc.red(`[say] --since: cannot read "${raw}". Use a duration (7d, 24h, 90m) or a date (2026-09-15).`));
    process.exitCode = 1;
}

/** `tools say logs`: the newest calls, oldest first, with who made them and what came of it. */
export async function showCallLogs(opts: LogsOptions): Promise<void> {
    const sinceMs = parseSince(opts.since);

    if (sinceMs === null) {
        rejectSince(opts.since as string);
        return;
    }

    const now = Date.now();
    const db = openCallsDb();
    let records: SayCallRecord[];

    try {
        records = listCalls(db, { limit: opts.limit, attention: opts.attention, grep: opts.grep, sinceMs });
    } finally {
        db.close();
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(records, null, 2));
        return;
    }

    const filters = describeFilters(opts);
    renderCliHeader("say calls", `${records.length} calls · limit ${opts.limit}${filters ? ` · ${filters}` : ""}`);

    if (records.length === 0) {
        out.println(pc.dim("  No calls recorded yet."));
        out.println(pc.dim(`  Database: ${callsDbPath()}`));
        out.println();
        return;
    }

    const workspaceIds = records.map((r) => r.caller.workspaceId).filter((id): id is string => id !== null);
    const names = await resolveWorkspaceNames(workspaceIds);

    if (opts.full) {
        for (const record of records) {
            renderCallDetail(record, names, now);
        }
    } else {
        renderLogsTable(records, names, now);
    }

    const attention = records.filter((r) => r.attention).length;
    const failed = records.filter((r) => r.status === "failed").length;
    const noOutcome = records.filter((r) => r.status === "started" && now - r.ts >= NO_OUTCOME_AFTER_MS).length;
    const counts = [`${records.length} calls`, `${attention} attention`, `${failed} failed`];

    if (noOutcome > 0) {
        counts.push(pc.yellow(`${noOutcome} without outcome`));
    }

    out.println();
    out.println(`  ${counts.join(pc.dim(" · "))}`);
    out.println();
    renderCliSection("Next");
    renderCliKeyRow("Detail", pc.dim("tools say logs -n 5 --full"));
    renderCliKeyRow("Attention", pc.dim("tools say logs --attention"));
    renderCliKeyRow("Search", pc.dim('tools say logs --grep "deploy" --since 7d'));
    renderCliKeyRow("Jump", pc.dim("tools claude cmux focus <session>"));
    renderCliKeyRow("Stats", pc.dim("tools say stats"));
    out.println();
}

function share(count: number, total: number): string {
    if (total === 0) {
        return "0%";
    }

    return `${Math.round((count / total) * 100)}%`;
}

function bar(count: number, max: number, width = 20): string {
    if (max === 0) {
        return "";
    }

    return pc.cyan("█".repeat(Math.max(count > 0 ? 1 : 0, Math.round((count / max) * width))));
}

function renderHourSparkline(byHour: number[]): void {
    const max = Math.max(...byHour);
    const hours = byHour.map((_, hour) => pad2(hour)).join(" ");
    const bars = byHour
        .map((count) => {
            if (count === 0 || max === 0) {
                return pc.dim("· ");
            }

            const level = Math.min(SPARK.length - 1, Math.round((count / max) * (SPARK.length - 1)));
            return `${pc.cyan(SPARK[level])} `;
        })
        .join(" ");

    out.println(`  ${pc.dim(hours)}`);
    out.println(`  ${bars}`);
    out.println(pc.dim(`  busiest hour: ${max} calls`));
    out.println();
}

function renderStats(stats: SayCallStats, names: Map<string, string>, opts: StatsViewOptions): void {
    const window = opts.since ? `since ${opts.since}` : "all time";
    renderCliHeader("say stats", `${stats.total} calls · ${window}`);

    renderCliSection("Overview");
    renderCliKeyRow("Calls", String(stats.total), 12);
    renderCliKeyRow("Attention", `${stats.attention} ${pc.dim(`(${share(stats.attention, stats.total)})`)}`, 12);
    renderCliKeyRow("First", stats.firstTs === null ? "—" : formatFullWhen(stats.firstTs), 12);
    renderCliKeyRow("Last", stats.lastTs === null ? "—" : formatFullWhen(stats.lastTs), 12);
    renderCliKeyRow(
        "No outcome",
        stats.noOutcome > 0 ? pc.yellow(`${stats.noOutcome} (speaker never reported back)`) : "0",
        12
    );

    if (stats.latency) {
        renderCliKeyRow(
            "Latency",
            `median ${formatDuration(stats.latency.medianMs)} · p90 ${formatDuration(stats.latency.p90Ms)} · max ${formatDuration(stats.latency.maxMs)} ${pc.dim(`(${stats.latency.count} finished calls, call to end of speech)`)}`,
            12
        );
    }

    out.println();

    if (stats.total === 0) {
        out.println(pc.dim(`  Nothing recorded yet. Database: ${callsDbPath()}`));
        out.println();
        return;
    }

    renderCliSection("Outcomes");
    const outcomes = createBoxTable(["STATUS", "CALLS", "SHARE"]);

    for (const row of stats.byStatus) {
        outcomes.push([pc.white(row.key), String(row.count), share(row.count, stats.total)]);
    }

    out.println(outcomes.toString());
    out.println();

    renderCliSection("By agent");
    const agents = createBoxTable(["AGENT", "CALLS", "ATTENTION", "SHARE"]);

    for (const row of stats.byAgent) {
        agents.push([
            pc.white(agentLabel(row.key)),
            String(row.count),
            row.attention > 0 ? pc.yellow(String(row.attention)) : pc.dim("0"),
            share(row.count, stats.total),
        ]);
    }

    out.println(agents.toString());
    out.println();

    renderCliSection("By app profile");
    const apps = createBoxTable(["APP", "CALLS", "SHARE"]);

    for (const row of stats.byApp) {
        apps.push([row.key ? pc.white(row.key) : pc.dim("(none)"), String(row.count), share(row.count, stats.total)]);
    }

    out.println(apps.toString());
    out.println();

    if (stats.byProvider.length > 0) {
        renderCliSection("By provider (finished calls)");
        const providers = createBoxTable(["PROVIDER", "CALLS", "CACHE HITS", "FALLBACKS"]);

        for (const row of stats.byProvider) {
            providers.push([
                row.key ? pc.white(row.key) : pc.dim("(none)"),
                String(row.count),
                `${row.cacheHits} ${pc.dim(`(${share(row.cacheHits, row.count)})`)}`,
                row.fallbacks > 0 ? pc.yellow(String(row.fallbacks)) : pc.dim("0"),
            ]);
        }

        out.println(providers.toString());
        out.println();
    }

    renderCliSection(`By day (last ${stats.byDay.length})`);
    const dayMax = Math.max(...stats.byDay.map((d) => d.count));
    const days = createBoxTable(["DAY", "CALLS", "ATTENTION", ""]);

    for (const row of stats.byDay) {
        days.push([
            pc.white(row.day),
            String(row.count),
            row.attention > 0 ? pc.yellow(String(row.attention)) : pc.dim("0"),
            bar(row.count, dayMax),
        ]);
    }

    out.println(days.toString());
    out.println();

    renderCliSection("By hour of day (local)");
    renderHourSparkline(stats.byHour);

    if (stats.topSessions.length > 0) {
        renderCliSection("Top sessions");
        const sessions = createBoxTable(["SESSION", "AGENT", "WORKSPACE", "CALLS", "LAST"]);

        for (const row of stats.topSessions) {
            const name = row.workspaceId ? names.get(row.workspaceId.toLowerCase()) : undefined;
            sessions.push([
                pc.magenta(row.sessionId.slice(0, 8)),
                agentLabel(row.agent),
                truncateDisplay(name ?? row.workspaceId?.slice(0, 8), 24),
                String(row.count),
                pc.dim(formatFullWhen(row.lastTs)),
            ]);
        }

        out.println(sessions.toString());
        out.println();
    }

    renderCliSection("Top phrases");
    const phrases = createBoxTable(["TEXT", "CALLS"]);

    for (const row of stats.topTexts) {
        phrases.push([truncateDisplay(row.text, 70), String(row.count)]);
    }

    out.println(phrases.toString());
    out.println();
}

/** `tools say stats`: how `tools say` gets used, over a window or all time. */
export async function showCallStats(opts: StatsViewOptions): Promise<void> {
    const sinceMs = parseSince(opts.since);

    if (sinceMs === null) {
        rejectSince(opts.since as string);
        return;
    }

    const db = openCallsDb();
    let stats: SayCallStats;

    try {
        stats = computeStats(db, { sinceMs });
    } finally {
        db.close();
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(stats, null, 2));
        return;
    }

    const names = await resolveWorkspaceNames(
        stats.topSessions.map((s) => s.workspaceId).filter((id): id is string => id !== null)
    );
    renderStats(stats, names, opts);
}

/** `tools say logs` / `tools say stats` — keep the commander blocks off the 1.4k-line CLI. */
export function registerCallLogCommands(program: Command): void {
    program
        .command("logs")
        .description(
            "The last N calls: when, which agent and session, which cmux workspace, what was said, what happened"
        )
        .option("-n, --limit <count>", "How many calls to show", (v: string) => Number.parseInt(v, 10), 100)
        .option("--attention", "Only calls whose text carries the 'Attention please!!' marker")
        .option("--grep <text>", "Only calls whose text contains this (case-insensitive)")
        .option("--since <when>", "Only calls after a duration ago (7d, 24h, 90m) or a date (2026-09-15)")
        .option(
            "--full",
            "One detail block per call instead of the table: argv, cwd, process chain, pids, jump command"
        )
        .option("--json", "Print the records as JSON")
        .action(async (opts: LogsOptions) => {
            await showCallLogs(opts);
        });

    program
        .command("stats")
        .description(
            "Call statistics: outcomes, agents, app profiles, providers, days, hours, top sessions and phrases"
        )
        .option("--since <when>", "Only calls after a duration ago (7d, 24h, 90m) or a date (2026-09-15)")
        .option("--json", "Print the aggregates as JSON")
        .action(async (opts: StatsViewOptions) => {
            await showCallStats(opts);
        });
}

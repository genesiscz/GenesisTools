import { parseVariadic } from "@genesiscz/utils/cli";
import { FAILURE_KINDS, type FailureKind, failuresDir, type ToolFailure } from "@genesiscz/utils/cli/failures/record";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDate } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { dayLogsDir } from "@genesiscz/utils/logger/day-logs";
import { formatTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { crashReports, crashReportsDir } from "../lib/crash-reports";
import { LEVELS, type LevelName, levelName, queryDayLog } from "../lib/day-log";
import { type FailureFilter, GROUP_KEYS, groupFailures, isGroupKey, loadFailures, usageGaps } from "../lib/failures";
import { queryProfileLog } from "../lib/profile-log";
import { daysIn, resolveWindow, type TimeWindow } from "../lib/window";

interface WindowOptions {
    since?: string;
    until?: string;
    json?: boolean;
}

interface FilterOptions extends WindowOptions {
    tool?: string[];
    kind?: string[];
    command?: string;
    agent?: string;
    model?: string;
    session?: string;
    exit?: string[];
    grep?: string;
    interrupts?: boolean;
}

const KIND_COLOR: Record<FailureKind, (text: string) => string> = {
    usage: pc.yellow,
    error: pc.red,
    crash: pc.magenta,
    exit: pc.red,
    interrupt: pc.dim,
};

function withWindow(command: Command, since = "24h"): Command {
    return command
        .option("--since <when>", "Start of the window: 30m, 24h, 7d, HH:MM, YYYY-MM-DD", since)
        .option("--until <when>", "End of the window (default: now)")
        .option("--json", "Print JSON");
}

function withFilters(command: Command): Command {
    return withWindow(command)
        .option("--tool <names...>", "Only these tools (comma or space separated)")
        .option("--kind <kinds...>", `Only these kinds: ${FAILURE_KINDS.join(", ")}`)
        .option("--command <text>", "Command path contains this (usage sessions)")
        .option("--agent <agent>", "claude-code, codex, grok, copilot or unknown (a shell)")
        .option("--model <text>", "Model contains this (sonnet, opus, haiku, gpt-6)")
        .option("--session <id>", "Session id or its leading part")
        .option("--exit <codes...>", "Only these exit codes")
        .option("--grep <text>", "Message, arguments or stderr contain this")
        .option("--interrupts", "Include Ctrl-C and SIGTERM endings");
}

function windowOf(options: WindowOptions): TimeWindow {
    return resolveWindow({ since: options.since, until: options.until });
}

function filterOf(options: FilterOptions): FailureFilter {
    const kinds = parseVariadic(options.kind);
    const unknown = kinds.filter((kind) => !FAILURE_KINDS.some((known) => known === kind));
    if (unknown.length > 0) {
        throw new Error(`--kind ${unknown.join(", ")} is not a kind; use ${FAILURE_KINDS.join(", ")}`);
    }

    return {
        kinds: FAILURE_KINDS.filter((kind) => kinds.includes(kind)),
        tools: parseVariadic(options.tool),
        command: options.command,
        agent: options.agent,
        model: options.model,
        session: options.session,
        exitCodes: parseVariadic(options.exit).map(Number),
        grep: options.grep,
        interrupts: options.interrupts === true,
    };
}

function clock(iso: string, window: TimeWindow): string {
    const at = new Date(iso);
    const time = at.toTimeString().slice(0, 8);
    return daysIn(window).length > 1 ? `${formatLocalDate(at).slice(5)} ${time}` : time;
}

/** Day-log times are UTC; a reader works in local time. */
function localTime(iso: string, millis = false): string {
    const at = new Date(iso);
    const time = at.toTimeString().slice(0, 8);
    return millis ? `${time}.${String(at.getMilliseconds()).padStart(3, "0")}` : time;
}

function who(failure: ToolFailure): string {
    const caller = failure.caller;
    if (!caller || caller.agent === "unknown") {
        return "shell";
    }

    return caller.model ?? caller.agent;
}

function printFailures(failures: ToolFailure[], window: TimeWindow): void {
    if (failures.length === 0) {
        out.println(pc.dim("No failures in this window."));
        return;
    }

    const rows = failures.map((failure) => [
        pc.dim(clock(failure.at, window)),
        KIND_COLOR[failure.kind](failure.kind),
        failure.command ?? failure.tool,
        String(failure.exitCode ?? "-"),
        pc.cyan(who(failure)),
        truncateDisplay(failure.message, 90),
        pc.dim(failure.id),
    ]);
    out.println(formatTable(rows, ["TIME", "KIND", "COMMAND", "EXIT", "WHO", "MESSAGE", "ID"]));
    out.println(pc.dim(`\n${failures.length} failures. Details: ${toolCommand("genesis-tools logs show", "<id>")}`));
}

function registerFailures(logs: Command): void {
    withFilters(logs.command("failures").alias("list").description("Failed tool runs, newest last"))
        .option("--limit <n>", "Show the newest N", "40")
        .action((options: FilterOptions & { limit: string }) => {
            const window = windowOf(options);
            const failures = loadFailures({ window, filter: filterOf(options) }).slice(-Number(options.limit));
            if (options.json) {
                out.result(failures);
                return;
            }

            printFailures(failures, window);
        });

    withFilters(logs.command("stats").description("Failure counts grouped by tool, kind, model and more"))
        .option("--by <keys...>", `Group by: ${GROUP_KEYS.join(", ")}`, ["tool", "kind"])
        .option("--top <n>", "Show the top N groups", "30")
        .action((options: FilterOptions & { by: string[]; top: string }) => {
            const by = parseVariadic(options.by);
            const unknown = by.filter((key) => !isGroupKey(key));
            if (unknown.length > 0) {
                throw new Error(`--by ${unknown.join(", ")} is not a key; use ${GROUP_KEYS.join(", ")}`);
            }

            const ordered = by.filter(isGroupKey);
            const failures = loadFailures({ window: windowOf(options), filter: filterOf(options) });
            const groups = groupFailures(failures, ordered).slice(0, Number(options.top));
            if (options.json) {
                out.result({ total: failures.length, by: ordered, groups });
                return;
            }

            const rows = groups.map((group) => [
                String(group.count),
                ...group.key.map((value) => truncateDisplay(value, 70)),
                String(group.sessions),
                truncateDisplay(group.models.join(", "), 40),
                pc.dim(group.lastId),
            ]);
            out.println(
                formatTable(rows, ["COUNT", ...ordered.map((key) => key.toUpperCase()), "SESSIONS", "MODELS", "LAST"])
            );
            out.println(pc.dim(`\n${failures.length} failures in ${groups.length} groups.`));
        });

    withFilters(logs.command("usage").description("Command lines the tools refused: where help or an alias is missing"))
        .option("--top <n>", "Show the top N", "25")
        .action((options: FilterOptions & { top: string }) => {
            const gaps = usageGaps(loadFailures({ window: windowOf(options), filter: filterOf(options) })).slice(
                0,
                Number(options.top)
            );
            if (options.json) {
                out.result(gaps);
                return;
            }

            if (gaps.length === 0) {
                out.println(pc.dim("No refused command lines in this window."));
                return;
            }

            for (const gap of gaps) {
                out.println(`${pc.bold(String(gap.count).padStart(4))}  ${pc.cyan(gap.command)}  ${gap.message}`);
                out.println(pc.dim(`      models: ${gap.models.join(", ") || "-"}`));
                for (const example of gap.examples) {
                    out.println(pc.dim(`      $ ${example}`));
                }
            }
        });
}

function registerShow(logs: Command): void {
    logs.command("show")
        .description("One failure in full, with the day-log lines its process wrote")
        .argument("<id>", "The failure id (from the list), or its leading part")
        .option("--since <when>", "How far back to look for the id", "7d")
        .option("--json", "Print JSON")
        .action(async (id: string, options: WindowOptions) => {
            const failure = loadFailures({ window: windowOf(options), filter: { interrupts: true } })
                .reverse()
                .find((candidate) => candidate.id.startsWith(id));
            if (!failure) {
                throw new Error(`no failure with id ${id} in the last ${options.since ?? "7d"} (try --since 30d)`);
            }

            const end = new Date(failure.at);
            const start = new Date(end.getTime() - failure.durationMs - 1000);
            const lines = await queryDayLog({
                window: { from: start, to: new Date(end.getTime() + 1000) },
                pid: failure.pid,
                limit: 200,
            });
            if (options.json) {
                out.result({ failure, dayLog: lines.map((line) => line.record) });
                return;
            }

            const caller = failure.caller;
            const rows: Array<[string, string | null | undefined]> = [
                ["kind", `${failure.kind}${failure.fatal ? "" : " (the process went on)"}`],
                ["at", new Date(failure.at).toLocaleString()],
                ["command", `tools ${failure.tool} ${failure.argv.join(" ")}`],
                ["exit", String(failure.exitCode ?? "-")],
                ["message", failure.message],
                ["cwd", failure.cwd],
                ["took", `${failure.durationMs} ms`],
                ["pid", `${failure.pid} (parent ${failure.ppid})`],
                ["checkout", failure.toolsRoot],
                ["agent", caller ? `${caller.agent}${caller.aiAgent ? ` (${caller.aiAgent})` : ""}` : null],
                ["model", caller?.model ? `${caller.model}${caller.effort ? `, effort ${caller.effort}` : ""}` : null],
                [
                    "session",
                    caller?.sessionId
                        ? `${caller.sessionId}${caller.sessionTitle ? `  ${caller.sessionTitle}` : ""}`
                        : null,
                ],
                ["project", caller ? `${caller.project} @ ${caller.branch ?? "?"} ${caller.commitSha ?? ""}` : null],
                ["app trace", failure.traceId],
            ];
            for (const [name, value] of rows) {
                if (value) {
                    out.println(`${pc.dim(name.padEnd(10))} ${value}`);
                }
            }

            if (failure.stack) {
                out.println(`\n${pc.bold("stack")}\n${pc.dim(failure.stack)}`);
            }

            if (failure.stderrTail) {
                out.println(`\n${pc.bold("stderr (tail)")}\n${failure.stderrTail}`);
            }

            out.println(`\n${pc.bold(`day log, pid ${failure.pid}`)} ${pc.dim(`(${lines.length} lines)`)}`);
            for (const line of lines) {
                out.println(`${pc.dim(localTime(line.time, true))} ${levelName(line.level).padEnd(5)} ${line.msg}`);
            }
        });
}

function registerCrashes(logs: Command): void {
    withWindow(
        logs.command("crashes").description("Crashed tool runs and macOS crash reports of GenesisTools processes"),
        "7d"
    ).action((options: WindowOptions) => {
        const window = windowOf(options);
        const failures = loadFailures({ window, filter: { kinds: ["crash"] } });
        const reports = crashReports(window);
        if (options.json) {
            out.result({ failures, reports });
            return;
        }

        printFailures(failures, window);
        out.println(`\n${pc.bold("macOS crash reports")} ${pc.dim(crashReportsDir())}`);
        if (reports.length === 0) {
            out.println(pc.dim("None in this window."));
        }

        for (const report of reports) {
            out.println(`${pc.dim(clock(report.at, window))}  ${report.process}  ${pc.dim(report.path)}`);
        }
    });
}

function registerDay(logs: Command): void {
    withWindow(logs.command("day").description("The day log (every tool's pino records), filtered"), "1h")
        .option("--level <level>", `Lowest level: ${Object.keys(LEVELS).join(", ")}`, "warn")
        .option("--tool <name>", "Only records of this tool")
        .option("--pid <pid>", "Only records of this process")
        .option("--grep <text>", "The record contains this")
        .option("--limit <n>", "Show the newest N", "100")
        .action(
            async (
                options: WindowOptions & { level: string; tool?: string; pid?: string; grep?: string; limit: string }
            ) => {
                const minLevel = LEVELS[options.level as LevelName];
                if (minLevel === undefined) {
                    throw new Error(`--level ${options.level} is not a level; use ${Object.keys(LEVELS).join(", ")}`);
                }

                const entries = await queryDayLog({
                    window: windowOf(options),
                    minLevel,
                    tool: options.tool,
                    pid: options.pid ? Number(options.pid) : undefined,
                    grep: options.grep,
                    limit: Number(options.limit),
                });
                if (options.json) {
                    out.result(entries.map((entry) => entry.record));
                    return;
                }

                for (const entry of entries) {
                    const level = levelName(entry.level);
                    const color =
                        entry.level >= LEVELS.error ? pc.red : entry.level >= LEVELS.warn ? pc.yellow : pc.dim;
                    out.println(
                        `${pc.dim(localTime(entry.time))} ${color(level.padEnd(5))} ${pc.cyan((entry.tool ?? "-").padEnd(14))} ${pc.dim(String(entry.pid ?? "").padStart(6))} ${entry.msg}`
                    );
                }

                out.println(pc.dim(`\n${entries.length} records.`));
            }
        );
}

function registerProfile(logs: Command): void {
    withWindow(
        logs
            .command("profile")
            .description(
                `Slow timers from the profiling log (${toolCommand("config profiling")}). Its lines carry no time of day, so --since and --until select whole days`
            ),
        "24h"
    )
        .option("--min-ms <ms>", "Only timers at least this long", "1000")
        .option("--scope <scopes...>", "Only these scopes (cli, spawn, agent-sessions, …)")
        .option("--grep <text>", "The label contains this")
        .option("--pid <pid>", "Only this process")
        .option("--top <n>", "Show the slowest N", "40")
        .action(
            (
                options: WindowOptions & { minMs: string; scope?: string[]; grep?: string; pid?: string; top: string }
            ) => {
                const days = daysIn(windowOf(options));
                const entries = queryProfileLog({
                    days,
                    minMs: Number(options.minMs),
                    scopes: parseVariadic(options.scope),
                    grep: options.grep,
                    pid: options.pid ? Number(options.pid) : undefined,
                })
                    .sort((a, b) => b.ms - a.ms)
                    .slice(0, Number(options.top));
                if (options.json) {
                    out.result(entries);
                    return;
                }

                const rows = entries.map((entry) => [
                    `${(entry.ms / 1000).toFixed(2)} s`,
                    entry.scope,
                    truncateDisplay(entry.label, 100),
                    String(entry.pid),
                    pc.dim(entry.day),
                ]);
                out.println(formatTable(rows, ["TIME", "SCOPE", "LABEL", "PID", "DAY"]));
                out.println(
                    pc.dim(`\nWhole days ${days[0]} to ${days[days.length - 1]}: profiling lines carry no time of day.`)
                );
            }
        );
}

export function registerLogsCommand(program: Command): void {
    const logs = program
        .command("logs")
        .description("Failures, crashes, the day log and profiling of every GenesisTools tool");
    registerFailures(logs);
    registerShow(logs);
    registerCrashes(logs);
    registerDay(logs);
    registerProfile(logs);
    logs.command("paths")
        .description("Where each log lives")
        .action(() => {
            const day = formatLocalDate(new Date());
            out.println(`failures   ${failuresDir()}/${day}-failures.jsonl`);
            out.println(`day log    ${dayLogsDir()}/${day}.log`);
            out.println(`profiling  ${dayLogsDir()}/${day}-profiling.log`);
            out.println(`crashes    ${crashReportsDir()}`);
        });
}

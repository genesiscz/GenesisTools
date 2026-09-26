import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { readProcsReport } from "../lib/procs/sources";
import { DEFAULT_GRACE_MS, type StopOutcome, stopOrphans, stopTree } from "../lib/procs/stop";
import type { ProcGroup, ProcsReport } from "../lib/procs/tree";

interface ProcsFlags {
    orphans?: boolean;
    energy?: boolean;
    json?: boolean;
    stop?: number;
    stopOrphans?: boolean;
    yes?: boolean;
    grace: number;
}

function pidArg(value: string): number {
    const pid = Number(value);

    if (!Number.isInteger(pid) || pid <= 1) {
        throw new InvalidArgumentError("a process id (a whole number above 1)");
    }

    return pid;
}

function secondsArg(value: string): number {
    const seconds = Number(value);

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) {
        throw new InvalidArgumentError("seconds between 0 and 120");
    }

    return Math.round(seconds * 1000);
}

function status(group: ProcGroup): string {
    if (group.orphan) {
        return formatDotStatus("err", "orphan");
    }

    if (group.idle) {
        return formatDotStatus("warn", "idle");
    }

    return formatDotStatus("ok", group.kind === "wrapper" ? "wrapper" : "live");
}

/** A process age the way a person reads it: `42m`, `5h 10m`, `6d 1h`. */
function ageText(ms: number): string {
    const minutes = Math.floor(ms / 60_000);

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function renderReport(report: ProcsReport, groups: ProcGroup[]): void {
    renderCliHeader("Agent processes", `${report.totals.orphans} orphans · ${report.totals.idle} idle`);
    out.println(
        pc.dim(
            `  ${report.totals.groups} trees · ${report.totals.processes} processes · ${report.totals.cpu.toFixed(1)} % CPU · ${formatBytes(report.totals.rssKb * 1024)}`
        )
    );

    if (groups.length === 0) {
        out.println(pc.dim("  Nothing to show."));
        return;
    }

    const headers = [
        "STATUS",
        "PID",
        "WHAT",
        "PROCS",
        "CPU %",
        "MEMORY",
        ...(report.energy ? ["ENERGY"] : []),
        "AGE",
        "SESSION / PARENT",
    ];
    const table = createBoxTable(headers);

    for (const group of groups) {
        const session = group.session
            ? `${group.session.sessionId.slice(0, 8)} ${truncateDisplay(group.session.title, 28)}`
            : `parent ${group.parent.pid}${group.parent.label ? ` ${group.parent.label}` : ""}`;
        table.push([
            status(group),
            String(group.rootPid),
            truncateDisplay(`${group.label}${group.own ? " (this session)" : ""}`, 34),
            String(group.totals.processes),
            group.totals.cpu.toFixed(1),
            formatBytes(group.totals.rssKb * 1024),
            ...(report.energy ? [group.totals.energy === null ? "—" : group.totals.energy.toFixed(1)] : []),
            group.ageMs === null ? "—" : ageText(group.ageMs),
            truncateDisplay(session, 40),
        ]);
    }

    out.println(table.toString());

    for (const group of groups.filter((entry) => entry.orphan || entry.idle)) {
        out.println(pc.dim(`  ${group.rootPid} ${group.label}: ${group.orphanReason ?? group.idleReason ?? ""}`));
    }

    out.println(
        pc.dim(
            `  Next: ${suggestCommand("tools hub", { replaceCommand: ["procs", "--stop", "<pid>"] })} · ${suggestCommand("tools hub", { replaceCommand: ["procs", "--stop-orphans"] })}`
        )
    );
}

function renderOutcome(outcome: StopOutcome): void {
    if (outcome.stopped) {
        out.log.success(
            `stopped ${outcome.pid} ${outcome.label} (${outcome.pids.length} processes, SIG${outcome.signal})`
        );
        return;
    }

    out.log.error(`did not stop ${outcome.pid} ${outcome.label}: ${outcome.reason ?? "unknown"}`);
}

async function confirmed(message: string, retry: string[], yes?: boolean): Promise<boolean> {
    if (yes) {
        return true;
    }

    if (!isInteractive()) {
        out.log.error("Non-interactive: read `tools hub procs` first, then pass --yes.");
        out.log.info(suggestCommand("tools hub", { replaceCommand: retry, add: ["--yes"] }));
        process.exitCode = 2;
        return false;
    }

    const ok = await p.confirm({ message, initialValue: false });

    if (p.isCancel(ok) || !ok) {
        out.log.info("Cancelled. Nothing was signalled.");
        process.exitCode = 1;
        return false;
    }

    return true;
}

/** `tools hub procs`: the hub's agent resource monitor, and the only door that stops a tree (by pid). */
export function registerProcsCommand(program: Command): void {
    program
        .command("procs")
        .description(
            "Agent CLI sessions (claude, codex, grok, cursor-agent) with their process trees (MCP servers, tool shells, tools children): CPU, memory, age, session, orphans; stops a tree by pid"
        )
        .option("--orphans", "only the orphans: an agent, MCP server, tool shell or wrapper whose parent is gone")
        .option("--energy", "add macOS energy impact (one `top` sample, about 1 s)")
        .option("--stop <pid>", "SIGTERM that process and its tree, then SIGKILL after the grace period", pidArg)
        .option("--stop-orphans", "stop every orphan tree (asks first; --yes in scripts)")
        .option("--grace <seconds>", "how long SIGTERM gets before SIGKILL", secondsArg, DEFAULT_GRACE_MS)
        .option("--yes", "skip the confirmation (the hub asks its own first)")
        .option("--json", "machine-readable output")
        .action(async (opts: ProcsFlags) => {
            if (opts.stop !== undefined) {
                // An explicit pid is the confirmation a script gives; a terminal still asks.
                const ok = await confirmed(
                    `Stop ${opts.stop} and its tree (SIGTERM, then SIGKILL)?`,
                    ["procs", "--stop", String(opts.stop)],
                    opts.yes || !isInteractive()
                );

                if (!ok) {
                    return;
                }

                const outcome = await stopTree({ pid: opts.stop, graceMs: opts.grace });
                process.exitCode = outcome.stopped ? 0 : 1;

                if (opts.json) {
                    out.result(outcome);
                    return;
                }

                renderOutcome(outcome);
                return;
            }

            if (opts.stopOrphans) {
                const report = await readProcsReport();
                const orphans = report.groups.filter((group) => group.orphan);

                if (orphans.length === 0) {
                    if (opts.json) {
                        out.result([]);
                    } else {
                        out.log.info("No orphans.");
                    }

                    return;
                }

                const list = orphans.map((group) => `${group.rootPid} ${group.label}`).join(", ");
                const ok = await confirmed(
                    `Stop ${orphans.length} orphan tree(s): ${list}?`,
                    ["procs", "--stop-orphans"],
                    opts.yes
                );

                if (!ok) {
                    return;
                }

                const outcomes = await stopOrphans({
                    graceMs: opts.grace,
                    only: orphans.map((group) => group.rootPid),
                });
                process.exitCode = outcomes.every((outcome) => outcome.stopped) ? 0 : 1;

                if (opts.json) {
                    out.result(outcomes);
                    return;
                }

                outcomes.forEach(renderOutcome);
                return;
            }

            const report = await readProcsReport({ energy: Boolean(opts.energy) });
            const shown = opts.orphans ? { ...report, groups: report.groups.filter((group) => group.orphan) } : report;

            if (opts.json) {
                out.result(shown);
                return;
            }

            for (const warning of report.warnings) {
                out.log.warn(warning);
            }

            renderReport(report, shown.groups);
        });
}

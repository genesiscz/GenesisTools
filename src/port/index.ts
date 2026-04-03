#!/usr/bin/env bun

import { enhanceHelp, isInteractive } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import {
    displayCleanPreview,
    displayCleanResults,
    displayPortDetail,
    displayPortTable,
    displayProcessTable,
    displayWatchEvent,
    displayWatchHeader,
} from "./lib/display";
import {
    findOrphanedPorts,
    getAllProcesses,
    getGitBranch,
    getListeningPorts,
    getPortDetails,
    isLikelyDevProcess,
    killProcesses,
    watchPorts,
} from "./lib/scanner";
import type { PortSnapshot } from "./lib/types";

interface RootOptions {
    all?: boolean;
    kill?: boolean;
    yes?: boolean;
}

type SelectionKind = "all" | "listeners" | "connections" | number;

function validatePort(portArg: string): number {
    const port = Number.parseInt(portArg, 10);

    if (Number.isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${pc.bold(portArg)}. Must be between 1 and 65535.`);
    }

    return port;
}

function buildSelectionOptions(processes: PortSnapshot[]): Array<{ value: SelectionKind; label: string }> {
    const options: Array<{ value: SelectionKind; label: string }> = [
        {
            value: "all",
            label: `All matching PIDs ${pc.dim("— kill everything on this port")}`,
        },
    ];
    const hasListeners = processes.some((processInfo) => processInfo.state === "LISTEN");
    const hasConnections = processes.some((processInfo) => processInfo.state !== "LISTEN");

    if (hasListeners && hasConnections) {
        options.push(
            { value: "listeners", label: `All listeners ${pc.dim("— LISTEN state only")}` },
            { value: "connections", label: `All connections ${pc.dim("— active clients only")}` }
        );
    }

    for (const processInfo of processes) {
        options.push({
            value: processInfo.pid,
            label: `PID ${pc.bold(String(processInfo.pid))} ${pc.dim(`— ${processInfo.processName} (${processInfo.state})`)}`,
        });
    }

    return options;
}

function resolveSelectedPids(selections: SelectionKind[], processes: PortSnapshot[]): number[] {
    const values = new Set<number>();

    for (const selection of selections) {
        if (selection === "all") {
            for (const processInfo of processes) {
                values.add(processInfo.pid);
            }
            continue;
        }

        if (selection === "listeners") {
            for (const processInfo of processes) {
                if (processInfo.state === "LISTEN") {
                    values.add(processInfo.pid);
                }
            }
            continue;
        }

        if (selection === "connections") {
            for (const processInfo of processes) {
                if (processInfo.state !== "LISTEN") {
                    values.add(processInfo.pid);
                }
            }
            continue;
        }

        values.add(selection);
    }

    return Array.from(values);
}

async function maybeKillProcessesForPort(
    processes: PortSnapshot[],
    options: { forceAll?: boolean; yes?: boolean }
): Promise<void> {
    let pidsToKill: number[];

    if (options.forceAll) {
        pidsToKill = [...new Set(processes.map((processInfo) => processInfo.pid))];
    } else if (!isInteractive()) {
        p.log.info(
            `Non-interactive mode: re-run with ${pc.cyan("tools port --kill --yes <number>")} to terminate these PIDs.`
        );
        return;
    } else {
        const selected = await withCancel(
            p.multiselect<SelectionKind>({
                message: `Select what to kill ${pc.dim("(space to toggle, enter to confirm)")}`,
                options: buildSelectionOptions(processes),
                required: true,
            })
        );

        pidsToKill = resolveSelectedPids(selected as SelectionKind[], processes);
    }

    if (pidsToKill.length === 0) {
        p.cancel("Nothing selected.");
        return;
    }

    if (!options.yes) {
        const labels = pidsToKill.map((pid) => {
            const processInfo = processes.find((entry) => entry.pid === pid);
            return processInfo ? `${pid} (${processInfo.processName})` : String(pid);
        });
        const confirmed = await withCancel(
            p.confirm({
                message: `Kill ${pidsToKill.length} process(es)? ${pc.dim(labels.join(", "))}`,
            })
        );

        if (!confirmed) {
            p.cancel("Aborted.");
            return;
        }
    }

    const results = await killProcesses(pidsToKill);

    for (const result of results) {
        if (result.status === "killed") {
            p.log.success(`PID ${result.pid} terminated`);
            continue;
        }

        if (result.status === "force-killed") {
            p.log.warn(`PID ${result.pid} force-killed (SIGKILL)`);
            continue;
        }

        p.log.error(`PID ${result.pid}: ${result.error}`);
    }
}

async function showPortOverview(includeSystem: boolean): Promise<void> {
    const ports = getListeningPorts().filter(
        (snapshot) => includeSystem || isLikelyDevProcess(snapshot.processName, snapshot.command)
    );
    displayPortTable(ports, !includeSystem);
}

async function inspectPort(portArg: string, options: RootOptions): Promise<void> {
    const port = validatePort(portArg);
    const snapshots = getPortDetails(port);
    const gitBranch = snapshots.length > 0 ? getGitBranch(snapshots[0].cwd) : null;

    displayPortDetail(port, snapshots, gitBranch);

    if (snapshots.length === 0) {
        return;
    }

    if (options.kill || isInteractive()) {
        await maybeKillProcessesForPort(snapshots, {
            forceAll: options.kill,
            yes: options.yes,
        });
    }
}

async function showProcessOverview(includeSystem: boolean): Promise<void> {
    const processes = getAllProcesses()
        .filter((processInfo) => includeSystem || isLikelyDevProcess(processInfo.processName, processInfo.command))
        .sort((left, right) => right.cpu - left.cpu || left.pid - right.pid);

    displayProcessTable(processes, !includeSystem);
}

async function cleanPorts(options: { yes?: boolean }): Promise<void> {
    const orphaned = findOrphanedPorts();
    displayCleanPreview(orphaned);

    if (orphaned.length === 0) {
        return;
    }

    if (!options.yes) {
        if (!isInteractive()) {
            p.log.info(
                `Re-run with ${pc.cyan("tools port clean --yes")} to terminate these listeners in non-interactive mode.`
            );
            return;
        }

        const confirmed = await withCancel(
            p.confirm({
                message: `Kill ${orphaned.length} orphaned/zombie listener(s)?`,
            })
        );

        if (!confirmed) {
            p.cancel("Aborted.");
            return;
        }
    }

    const results = await killProcesses([...new Set(orphaned.map((snapshot) => snapshot.pid))]);
    displayCleanResults(orphaned, results);
}

async function watchPortActivity(options: { all?: boolean; interval?: string }): Promise<void> {
    const intervalMs = options.interval ? Number.parseInt(options.interval, 10) : 2000;

    if (Number.isNaN(intervalMs) || intervalMs < 250) {
        throw new Error(`Invalid interval: ${pc.bold(options.interval ?? "")}. Use a number of milliseconds >= 250.`);
    }

    displayWatchHeader(Boolean(options.all), intervalMs);
    const timer = watchPorts(displayWatchEvent, {
        includeSystem: Boolean(options.all),
        intervalMs,
    });

    await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
            clearInterval(timer);
            console.log();
            p.outro(pc.dim("Stopped watching."));
            resolve();
        });
    });
}

const program = new Command();

program
    .name("port")
    .description("Inspect, list, watch, and clean processes that own local ports")
    .argument("[port]", "Port number to inspect")
    .option("-a, --all", "Include system processes and listeners in list views")
    .option("-k, --kill", "Kill every PID found for the inspected port")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (portArg: string | undefined, options: RootOptions) => {
        if (!portArg) {
            await showPortOverview(Boolean(options.all));
            return;
        }

        await inspectPort(portArg, options);
    });

program
    .command("ps")
    .description("Show a colorful process listing focused on dev workflows")
    .option("-a, --all", "Include system processes")
    .action(async (options: { all?: boolean }) => {
        await showProcessOverview(Boolean(options.all));
    });

program
    .command("clean")
    .description("Find and terminate orphaned or zombie listeners")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (options: { yes?: boolean }) => {
        await cleanPorts(options);
    });

program
    .command("watch")
    .description("Watch for ports opening and closing in real time")
    .option("-a, --all", "Include system listeners")
    .option("-i, --interval <ms>", "Polling interval in milliseconds", "2000")
    .action(async (options: { all?: boolean; interval?: string }) => {
        await watchPortActivity(options);
    });

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }
}

main();

#!/usr/bin/env bun

import { withCancel } from "@app/utils/prompts/clack/helpers";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

interface PortProcess {
    pid: number;
    command: string;
    user: string;
    state: string;
    name: string;
    fd: string;
}

const STATE_PRIORITY: Record<string, number> = {
    LISTEN: 1,
    ESTABLISHED: 2,
    CLOSE_WAIT: 3,
    TIME_WAIT: 4,
    FIN_WAIT_1: 5,
    FIN_WAIT_2: 6,
    SYN_SENT: 7,
    SYN_RECEIVED: 8,
};

function parseLsofOutput(output: string): PortProcess[] {
    const lines = output.trim().split("\n");

    if (lines.length <= 1) {
        return [];
    }

    const ownPid = process.pid;
    const byPid = new Map<number, PortProcess>();

    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s+/);

        if (parts.length < 9) {
            continue;
        }

        const pid = parseInt(parts[1], 10);

        if (isNaN(pid) || pid === ownPid) {
            continue;
        }

        const nameParts = parts.slice(8).join(" ");
        const stateMatch = nameParts.match(/\((\w+)\)$/);
        const state = stateMatch?.[1] ?? "UNKNOWN";

        const entry: PortProcess = {
            pid,
            command: parts[0],
            user: parts[2],
            state,
            name: nameParts,
            fd: parts[3],
        };

        const existing = byPid.get(pid);

        if (!existing) {
            byPid.set(pid, entry);
        } else {
            const existingPriority = STATE_PRIORITY[existing.state] ?? 99;
            const newPriority = STATE_PRIORITY[state] ?? 99;

            if (newPriority < existingPriority) {
                byPid.set(pid, entry);
            }
        }
    }

    return Array.from(byPid.values());
}

type SelectionKind = "all" | "listeners" | "connections" | number;

function buildSelectionOptions(processes: PortProcess[]): Array<{ value: SelectionKind; label: string }> {
    const options: Array<{ value: SelectionKind; label: string }> = [
        { value: "all", label: `All ${pc.dim("— kill everything")}` },
    ];

    const hasListeners = processes.some((proc) => proc.state === "LISTEN");
    const hasConnections = processes.some((proc) => proc.state !== "LISTEN");

    if (hasListeners && hasConnections) {
        options.push(
            { value: "listeners", label: `All listeners ${pc.dim("— LISTEN state only")}` },
            { value: "connections", label: `All connections ${pc.dim("— non-LISTEN only")}` }
        );
    }

    for (const proc of processes) {
        options.push({
            value: proc.pid,
            label: `PID ${pc.bold(String(proc.pid))} ${pc.dim(`— ${proc.command} (${proc.state})`)}`,
        });
    }

    return options;
}

function resolveSelectedPids(selections: SelectionKind[], processes: PortProcess[]): number[] {
    const pids = new Set<number>();

    for (const sel of selections) {
        if (sel === "all") {
            for (const proc of processes) {
                pids.add(proc.pid);
            }
        } else if (sel === "listeners") {
            for (const proc of processes) {
                if (proc.state === "LISTEN") {
                    pids.add(proc.pid);
                }
            }
        } else if (sel === "connections") {
            for (const proc of processes) {
                if (proc.state !== "LISTEN") {
                    pids.add(proc.pid);
                }
            }
        } else {
            pids.add(sel);
        }
    }

    return Array.from(pids);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function killProcesses(pids: number[]): Promise<void> {
    const results: Array<{ pid: number; status: "killed" | "force-killed" | "failed"; error?: string }> = [];

    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            if (message.includes("EPERM")) {
                results.push({ pid, status: "failed", error: "Permission denied — try running with sudo" });
            } else if (message.includes("ESRCH")) {
                results.push({ pid, status: "killed" });
            } else {
                results.push({ pid, status: "failed", error: message });
            }
        }
    }

    const pendingPids = pids.filter((pid) => !results.some((r) => r.pid === pid));

    if (pendingPids.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        for (const pid of pendingPids) {
            if (!isProcessAlive(pid)) {
                results.push({ pid, status: "killed" });
                continue;
            }

            try {
                process.kill(pid, "SIGKILL");
                results.push({ pid, status: "force-killed" });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                if (message.includes("ESRCH")) {
                    results.push({ pid, status: "killed" });
                } else {
                    results.push({ pid, status: "failed", error: message });
                }
            }
        }
    }

    for (const result of results) {
        if (result.status === "killed") {
            p.log.success(`PID ${result.pid} terminated`);
        } else if (result.status === "force-killed") {
            p.log.warn(`PID ${result.pid} force-killed (SIGKILL)`);
        } else {
            p.log.error(`PID ${result.pid}: ${result.error}`);
        }
    }
}

const program = new Command();

program
    .name("port")
    .description("Inspect and kill processes using a specific port")
    .argument("<port>", "Port number to inspect (1-65535)")
    .action(async (portArg: string) => {
        const port = parseInt(portArg, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
            p.log.error(`Invalid port number: ${pc.bold(portArg)}. Must be between 1 and 65535.`);
            process.exit(1);
        }

        p.intro(pc.bgCyan(pc.black(` port ${port} `)));

        const proc = Bun.spawn(["lsof", "-i", `:${port}`, "-n", "-P"], {
            stdout: "pipe",
            stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0 && stdout.trim() === "") {
            p.log.info(`No processes found on port ${pc.bold(String(port))}`);
            p.outro(pc.dim("Port is free."));
            return;
        }

        const processes = parseLsofOutput(stdout);

        if (processes.length === 0) {
            p.log.info(`No processes found on port ${pc.bold(String(port))}`);
            p.outro(pc.dim("Port is free."));
            return;
        }

        const rows = processes.map((proc) => [String(proc.pid), proc.command, proc.user, proc.state]);
        const table = formatTable(rows, ["PID", "Command", "User", "State"], { alignRight: [0] });
        p.note(table, `${processes.length} process(es) on port ${port}`);

        const selected = await withCancel(
            p.multiselect<SelectionKind>({
                message: `Select what to kill ${pc.dim("(space to toggle, enter to confirm)")}`,
                options: buildSelectionOptions(processes),
                required: true,
            })
        );

        const pidsToKill = resolveSelectedPids(selected as SelectionKind[], processes);

        if (pidsToKill.length === 0) {
            p.cancel("Nothing selected.");
            return;
        }

        const pidLabels = pidsToKill.map((pid) => {
            const proc = processes.find((entry) => entry.pid === pid);
            return proc ? `${pid} (${proc.command})` : String(pid);
        });

        const confirmed = await withCancel(
            p.confirm({
                message: `Kill ${pidsToKill.length} process(es)? ${pc.dim(pidLabels.join(", "))}`,
            })
        );

        if (!confirmed) {
            p.cancel("Aborted.");
            return;
        }

        await killProcesses(pidsToKill);
        p.outro(pc.green("Done."));
    });

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

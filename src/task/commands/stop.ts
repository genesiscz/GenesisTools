import { getPortDetails } from "@app/port/lib/scanner";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { stopSession } from "@app/task/lib/stop-session";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli/executor";
import { out } from "@genesiscz/utils/logger";
import { collectProcessTree, listPsTable } from "@genesiscz/utils/process/ps";
import type { Command } from "commander";

const DEFAULT_TIMEOUT_SECONDS = 5;

/** The running session whose process tree holds a LISTEN socket on `port`, if any. */
async function findSessionNameByPort(port: number): Promise<string | null> {
    const listenerPids = new Set(
        getPortDetails(port)
            .filter((snapshot) => snapshot.state === "LISTEN")
            .map((snapshot) => snapshot.pid)
    );

    if (listenerPids.size === 0) {
        return null;
    }

    const store = new TaskSessionStore();
    const names = await store.listSessionNames();
    const rows = await listPsTable();

    for (const name of names) {
        const meta = await store.reconcileSessionState(name);

        if (!meta || meta.pid === undefined || meta.exitCode !== undefined || meta.stopped) {
            continue;
        }

        const tree = collectProcessTree(meta.pid, rows);

        if (tree.some((pid) => listenerPids.has(pid))) {
            return name;
        }
    }

    return null;
}

function describeOutcome(name: string, outcome: Awaited<ReturnType<typeof stopSession>>): boolean {
    switch (outcome.status) {
        case "not-found":
            out.printlnErr(`error: no session named "${name}"`);
            return false;
        case "already-finished":
            out.printlnErr(`${name}: already ${outcome.previousState}, nothing to stop.`);
            return true;
        case "no-pid":
            out.printlnErr(`${name}: no recorded pid — marked stopped.`);
            return true;
        case "stopped":
            if (outcome.termedPids.length === 0) {
                out.printlnErr(`${name}: process already gone — marked stopped.`);
            } else if (outcome.killedPids.length === 0) {
                out.printlnErr(`${name}: SIGTERM ${outcome.termedPids.join(", ")} — exited within grace.`);
            } else {
                out.printlnErr(
                    `${name}: SIGTERM ${outcome.termedPids.join(", ")}; SIGKILL ${outcome.killedPids.join(", ")} after grace.`
                );
            }
            return true;
        case "failed":
            out.printlnErr(`${name}: not stopped, ${outcome.reason}; still alive: ${outcome.alivePids.join(", ")}`);
            return false;
        default:
            return true;
    }
}

async function runStop(name: string, timeoutSeconds: number): Promise<boolean> {
    const outcome = await stopSession({ name, graceMs: timeoutSeconds * 1000 });
    return describeOutcome(name, outcome);
}

async function listRunningSessionNames(store: TaskSessionStore): Promise<string[]> {
    const names = await store.listSessionNames();
    const running: string[] = [];

    for (const name of names.sort()) {
        const meta = await store.reconcileSessionState(name);

        if (meta && meta.exitCode === undefined && !meta.stopped) {
            running.push(name);
        }
    }

    return running;
}

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("SIGTERM (then SIGKILL after grace) a session's whole process tree, recorded as stopped")
        .option("--session <name>", "Session name (fuzzy-matched)")
        .option("--all", "Stop every currently running session")
        .option("--port <n>", "Stop the session that owns this TCP listener")
        .option("--timeout <seconds>", "Grace period before SIGKILL", String(DEFAULT_TIMEOUT_SECONDS))
        .option("--yes", "Skip the --all confirmation prompt (required in non-TTY mode)")
        .action(async (opts: { session?: string; all?: boolean; port?: string; timeout?: string; yes?: boolean }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const store = new TaskSessionStore();

            const timeoutSeconds = Number.parseFloat(opts.timeout ?? String(DEFAULT_TIMEOUT_SECONDS));

            if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
                out.printlnErr("error: --timeout requires a positive number of seconds");
                process.exit(1);
            }

            if (opts.all) {
                const running = await listRunningSessionNames(store);

                if (running.length === 0) {
                    out.printlnErr("No running sessions to stop.");
                    return;
                }

                if (!opts.yes) {
                    if (!isInteractive()) {
                        out.printlnErr("error: --all requires --yes in non-interactive mode.");
                        out.printlnErr(suggestCommand("tools task", { add: ["stop", "--all", "--yes"] }));
                        process.exit(1);
                    }

                    const confirmed = await p.confirm({
                        message: `Stop ${running.length} running session(s)? (${running.join(", ")})`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        out.printlnErr("Cancelled.");
                        return;
                    }
                }

                let allOk = true;
                for (const name of running) {
                    const ok = await runStop(name, timeoutSeconds);
                    allOk = allOk && ok;
                }

                process.exitCode = allOk ? 0 : 1;
                return;
            }

            if (opts.port !== undefined) {
                const port = Number.parseInt(opts.port, 10);

                if (Number.isNaN(port)) {
                    out.printlnErr("error: --port requires a number");
                    process.exit(1);
                }

                const name = await findSessionNameByPort(port);

                if (!name) {
                    out.printlnErr(`error: no running task session owns a listener on port ${port}`);
                    process.exit(1);
                }

                process.exitCode = (await runStop(name, timeoutSeconds)) ? 0 : 1;
                return;
            }

            let session = opts.session ?? globalOpts.session;

            if (!session) {
                if (!isInteractive()) {
                    out.printlnErr("error: --session, --all or --port required in non-interactive mode.");
                    out.printlnErr(suggestCommand("tools task", { add: ["stop", "--session", "my-session"] }));
                    process.exit(1);
                }

                const names = await store.listSessionNames();

                if (names.length === 0) {
                    out.printlnErr("No sessions to stop.");
                    return;
                }

                const picked = await p.select({
                    message: "Select session to stop",
                    options: names.map((n) => ({ value: n, label: n })),
                });

                if (p.isCancel(picked)) {
                    out.printlnErr("Cancelled.");
                    return;
                }

                session = picked;
            } else {
                session = await store.resolveSession(session);
            }

            process.exitCode = (await runStop(session, timeoutSeconds)) ? 0 : 1;
        });
}

import { commandWords, execTool, spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/ps";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { portIsOpen } from "./ensure";
import { LAUNCHD_PREFIX, parseLaunchctlList, type ServiceRow } from "./inventory";

const STOP_GRACE_MS = 10_000;
/** How long the pids and the port get to go after SIGKILL before the stop counts as failed. */
const KILL_GRACE_MS = 3_000;
const RESTART_WAIT_MS = 30_000;
const POLL_MS = 200;

/**
 * A launchd job with its own graceful restart: `tools daemon restart` stops with escalation and waits
 * for launchd to bring it back (`src/daemon/commands/restart.ts`).
 */
const OWN_RESTART: Record<string, string[]> = { [`${LAUNCHD_PREFIX}daemon`]: ["daemon", "restart"] };

export type LifecycleResult = { ok: true; message: string } | { ok: false; message: string };

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await check()) {
            return true;
        }

        await Bun.sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }

    return check();
}

function launchdPid(label: string): number | null {
    return (
        parseLaunchctlList(captureSync("launchctl", ["list"]).stdout).find((job) => job.label === label)?.pid ?? null
    );
}

/**
 * Stops a detached service: SIGTERM to its root and every process below it, the port free within
 * 10 s, then SIGKILL to what is left. Each signal first checks that the pid still runs the command
 * line the inventory read for it; a pid that does not is a reused pid and is left alone. A launchd
 * job is refused: KeepAlive would start it again at once.
 */
export async function stopService(
    row: ServiceRow,
    { graceMs = STOP_GRACE_MS, killGraceMs = KILL_GRACE_MS }: { graceMs?: number; killGraceMs?: number } = {}
): Promise<LifecycleResult> {
    if (row.managed === "launchd") {
        return { ok: false, message: `${row.name} is a launchd job (${row.label}); stopping it would only respawn it` };
    }

    const ours: number[] = [];

    for (const pid of row.pids) {
        if (signalIfUnchanged(row, pid, "SIGTERM")) {
            ours.push(pid);
        }
    }

    logger.debug({ id: row.id, pids: ours, of: row.pids }, "services: stopping");

    const stopped = await until(
        async () => ours.every((pid) => !isProcessAlive(pid)) && (row.port === null || !(await portIsOpen(row.port))),
        graceMs
    );

    if (!stopped) {
        for (const pid of ours.filter(isProcessAlive)) {
            signalIfUnchanged(row, pid, "SIGKILL");
        }

        // Verified, not assumed: a restart must not start a second server while the first still answers.
        const killed = await until(
            async () =>
                ours.every((pid) => !isProcessAlive(pid)) && (row.port === null || !(await portIsOpen(row.port))),
            killGraceMs
        );

        if (!killed) {
            return {
                ok: false,
                message: `${row.name} did not stop: ${row.port === null ? "a process" : `port ${row.port}`} still answers after SIGKILL`,
            };
        }
    }

    logger.debug({ id: row.id, pids: ours, graceful: stopped }, "services: stopped");
    return { ok: true, message: `stopped ${row.name}${stopped ? "" : " (killed after 10 s)"}` };
}

/** Signals `pid` only while it runs the command line the inventory read for it; true when the signal went out. */
function signalIfUnchanged(row: ServiceRow, pid: number, name: "SIGTERM" | "SIGKILL"): boolean {
    const expected = row.commands[pid];
    const identity = expected ? classifyPid(pid, expected) : null;

    if (identity?.status !== "live") {
        logger.debug(
            { id: row.id, pid, signal: name, status: identity?.status ?? "no inventory command" },
            "services: not signalled, the pid is gone or no longer the service"
        );
        return false;
    }

    try {
        // pid-verified: classifyPid just matched this pid's live command line to the one the inventory read.
        process.kill(pid, name);
        return true;
    } catch (error) {
        logger.debug({ error, pid, signal: name }, "services: the process was already gone");
        return false;
    }
}

/**
 * Restarts a service on the current code. A launchd job goes through launchd (`kickstart -k`, or the
 * job's own restart command), since KeepAlive owns its life; a detached service is stopped and
 * started again with its registered launch command, the way a click on its port starts it.
 */
export async function restartService(row: ServiceRow): Promise<LifecycleResult> {
    if (row.managed === "launchd" && row.label) {
        const label = row.label;
        const own = OWN_RESTART[label];

        if (own) {
            const run = await execTool(own);
            return run.exitCode === 0
                ? { ok: true, message: `restarted ${row.name}` }
                : { ok: false, message: `${own.join(" ")} failed: ${run.stderr.trim() || run.stdout.trim()}` };
        }

        const uid = process.getuid?.() ?? 0;
        const kick = captureSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);

        if (kick.status !== 0) {
            return { ok: false, message: `launchctl kickstart ${label} failed: ${kick.stderr.trim()}` };
        }

        const back = await until(async () => {
            const pid = launchdPid(label);
            return pid !== null && pid !== row.rootPid && (row.port === null || (await portIsOpen(row.port)));
        }, RESTART_WAIT_MS);
        return back
            ? { ok: true, message: `restarted ${row.name} through launchd` }
            : { ok: false, message: `${row.name} did not come back within 30 s (launchctl print gui/${uid}/${label})` };
    }

    // Its own arguments first (a server started on one folder or port must come back the same), the
    // registry's launch command only when the command lines name no tool.
    const registered = row.launch ? commandWords(row.launch) : [];
    const args = row.relaunch ?? (registered[0] === "tools" ? registered.slice(1) : null);

    if (row.port === null || !args) {
        return { ok: false, message: `${row.name}: no command to start it again` };
    }

    const port = row.port;
    const stopped = await stopService(row);

    if (!stopped.ok) {
        return stopped;
    }

    // Relative arguments (`artifact serve notes`) resolve against the server's own folder, not the caller's.
    const cwd = row.cwd ?? undefined;

    if (!cwd) {
        logger.warn({ id: row.id }, "services: the server's working directory was unreadable; starting it in ours");
    }

    logger.debug({ id: row.id, args, cwd }, "services: starting again");
    spawnToolDetached(args, { cwd });
    const up = await until(() => portIsOpen(port), RESTART_WAIT_MS);
    return up
        ? { ok: true, message: `restarted ${row.name} (tools ${args.join(" ")})` }
        : { ok: false, message: `${row.name} did not listen on ${port} within 30 s after tools ${args.join(" ")}` };
}

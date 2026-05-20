/**
 * Spawn a long-running child (typically `vite dev`) for a dashboard CLI launcher,
 * with three protections the naive `Bun.spawn` + `await proc.exited` pattern lacks:
 *
 * 1. **Signal forwarding.** SIGHUP/SIGINT/SIGTERM/SIGQUIT received by the parent
 *    are forwarded to the child so Vite gets a chance to clean up its sockets
 *    before being killed.
 * 2. **Orphan auto-exit.** macOS does not propagate parent death to children
 *    (no `PR_SET_PDEATHSIG`). When the launching shell dies, the child gets
 *    reparented to launchd (PPID=1) and lives forever — that is exactly how the
 *    2-day reas zombies came to exist. We poll `process.ppid`; the moment it
 *    flips to 1 we kill the Vite child and exit ourselves.
 * 3. **Force-exit after grace.** If the child ignores SIGTERM, escalate to
 *    SIGKILL after `gracePeriodMs` so we cannot leak.
 *
 * Returns the child's exit code so callers can `process.exit(code)` themselves
 * — we deliberately do NOT call `process.exit` here so callers can run cleanup.
 */
import logger from "@app/logger";

export interface SpawnDashboardOptions {
    /** Argv. First element is the executable. */
    cmd: readonly string[];
    /** Working directory. Defaults to `process.cwd()`. */
    cwd?: string;
    /** Extra env vars merged onto `process.env`. */
    env?: Record<string, string | undefined>;
    /** How often to check whether we have been reparented. Default 2000ms. */
    orphanPollMs?: number;
    /** How long to wait after SIGTERM before SIGKILL. Default 5000ms. */
    gracePeriodMs?: number;
}

export async function spawnDashboard(opts: SpawnDashboardOptions): Promise<number> {
    const { cmd, cwd, env, orphanPollMs = 2000, gracePeriodMs = 5000 } = opts;

    const child = Bun.spawn([...cmd], {
        cwd,
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, ...env },
    });

    let exiting = false;

    const escalateKill = (signal: NodeJS.Signals | number = "SIGTERM"): void => {
        if (exiting) {
            return;
        }

        exiting = true;
        try {
            child.kill(signal);
        } catch (err) {
            logger.debug({ err }, "[spawnDashboard] child.kill threw");
        }

        setTimeout(() => {
            if (!child.killed) {
                try {
                    child.kill("SIGKILL");
                } catch (err) {
                    logger.debug({ err }, "[spawnDashboard] SIGKILL escalation threw");
                }
            }
        }, gracePeriodMs).unref();
    };

    const handleSignal = (signal: NodeJS.Signals): void => {
        logger.debug({ signal }, "[spawnDashboard] received signal, forwarding to child");
        escalateKill(signal);
    };

    const signalsToForward: readonly NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];

    for (const sig of signalsToForward) {
        process.on(sig, () => handleSignal(sig));
    }

    const orphanTimer = setInterval(() => {
        if (process.ppid === 1) {
            logger.warn(
                "[spawnDashboard] reparented to launchd (parent shell died) — killing vite + exiting to avoid orphan"
            );
            escalateKill("SIGTERM");
        }
    }, orphanPollMs);
    orphanTimer.unref();

    const exitCode = await child.exited;
    clearInterval(orphanTimer);

    for (const sig of signalsToForward) {
        process.removeAllListeners(sig);
    }

    return exitCode;
}

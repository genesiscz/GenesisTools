import { getDaemonStatus } from "@app/daemon/lib/launchd";

export const RESTART_TIMEOUT_MS = 10_000;

/** Kill a process, ignoring ESRCH (already dead). Re-throws other errors. */
export function safeSigterm(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            throw err;
        }
    }
}

/**
 * Poll launchd until a new PID appears (different from oldPid).
 * Returns `{ pid }` on success, `null` on timeout.
 */
export async function waitForDaemonRestart(
    oldPid: number | null,
    timeoutMs = RESTART_TIMEOUT_MS
): Promise<{ pid: number } | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const status = await getDaemonStatus();

        if (status.running && status.pid && status.pid !== oldPid) {
            return { pid: status.pid };
        }

        await Bun.sleep(500);
    }

    return null;
}

/**
 * Standalone copy of the repo's canonical liveness probe (`src/utils/process-alive.ts`), because a
 * plugin file that runs cannot import `@genesiscz/*`. ESRCH is dead; EPERM and anything else is a
 * process that may exist, so a holder owned by another uid is never reported as gone.
 */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return !(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
    }
}

interface ErrnoException {
    code?: string;
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // POSIX semantics for `kill(pid, 0)`:
        //   ESRCH  → no such process (dead)
        //   EPERM  → process exists but the caller can't signal it
        //            (different uid / different sandbox / etc.)
        //   any other error → treat conservatively as alive so we don't
        //            falsely mark a sticky-PID session as exited.
        const code = (err as ErrnoException).code;
        if (code === "ESRCH") {
            return false;
        }

        return true;
    }
}

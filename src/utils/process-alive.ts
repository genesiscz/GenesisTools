/**
 * Canonical PID liveness probe via `kill(pid, 0)`.
 *
 * POSIX semantics:
 *   ESRCH  → no such process (dead)
 *   EPERM  → process exists but the caller can't signal it (different uid,
 *            different sandbox, etc.) — *alive*
 *   any other error → treat as alive (conservative, avoids false "exited"
 *            marks when the probe itself fails for an unexpected reason)
 *
 * Use this everywhere — never `try { process.kill(pid, 0); … } catch { false }`,
 * which collapses ESRCH and EPERM into "dead" and produces incorrect
 * results for cross-uid / sandboxed PIDs.
 *
 * On Windows, Node returns `EPERM` for nearly every signal-zero probe of a
 * pid not owned by the caller; this helper still reports those as alive,
 * which matches the "PID may exist" intent.
 *
 * Two byte-identical copies: `src/utils/process-alive.ts` and `plugins/genesis-tools/lib/process-alive.ts`, because
 * the plugin's hooks cannot import `@genesiscz` (`plugins/genesis-tools/lib/process-basics.test.ts` fails when they
 * differ). Edit the `src` one, then copy it over the plugin one.
 */

interface ErrnoException {
    code?: string;
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as ErrnoException).code;
        if (code === "ESRCH") {
            return false;
        }

        return true;
    }
}

/** A git child of the lint or the roster generator that runs longer than this is stuck: it is killed and named. */
export const CI_CHILD_TIMEOUT_MS = 60_000;

export interface DeadlineRun {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}

/**
 * `Bun.spawnSync` with a deadline, for the children the CI scripts wait on (the pre-push hook and CI run them). A child
 * that passes the deadline is killed and throws, so a stalled git never hangs the hook and never reads as an empty
 * listing or an ordinary failing exit.
 */
export function spawnWithDeadline(
    argv: string[],
    { cwd, timeoutMs = CI_CHILD_TIMEOUT_MS }: { cwd?: string; timeoutMs?: number } = {}
): DeadlineRun {
    const child = Bun.spawnSync(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
    });

    if (child.exitedDueToTimeout) {
        throw new Error(`${argv.slice(0, 3).join(" ")} did not finish within ${timeoutMs / 1000} s and was killed`);
    }

    return { exitCode: child.exitCode ?? 1, stdout: child.stdout, stderr: child.stderr };
}

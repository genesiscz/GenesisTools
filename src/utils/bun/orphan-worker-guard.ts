import { spawn } from "node:child_process";

/**
 * Bun isolate workers (`--test-worker --isolate`) are separate processes. The 5s
 * test timeout is enforced by the coordinator. If that parent dies (session killed,
 * gt-claude wrapper gone, PPID becomes 1), the timeout dies with it and a busy-loop
 * worker can spin at 100% CPU for days. Measured 2026-09-08: PID 59882, 1d12h, PPID 1.
 *
 * A JS timer cannot save that worker: a tight `for (;;)` never yields, so `setInterval`
 * never fires. macOS also has no `PR_SET_PDEATHSIG`. The guard is therefore a sibling
 * `/bin/sh` that `kill -0`s the original parent and `SIGKILL`s this pid when it is gone.
 *
 * `unref()` so the helper does not keep a finished worker's event loop alive.
 *
 * No `@genesiscz/*` imports: isolate workers and `/tmp` repro scripts must load this
 * file without the repo alias graph.
 */
export function installOrphanWorkerGuard(options?: { parentPid?: number; selfPid?: number }): void {
    if (process.env.GENESIS_TOOLS_TEST_ALLOW_ORPHAN_WORKERS === "1") {
        return;
    }

    if (process.platform === "win32") {
        return;
    }

    const parentPid = options?.parentPid ?? process.ppid;
    const selfPid = options?.selfPid ?? process.pid;

    if (!parentPid || parentPid <= 1) {
        return;
    }

    // `Bun.spawn` queues the fork on the event loop. A tight `for (;;)` after
    // install never ticks, so the helper would never start — the exact hang this
    // exists to stop. `child_process.spawn` forks before returning.
    const proc = spawn(
        "/bin/sh",
        [
            "-c",
            [
                `parent=${parentPid}`,
                `self=${selfPid}`,
                "while :; do",
                '  if ! kill -0 "$parent"; then',
                '    kill -KILL "$self"',
                "    exit 0",
                "  fi",
                "  sleep 1",
                "done",
            ].join("\n"),
        ],
        { stdio: "ignore" }
    );

    proc.unref();
}

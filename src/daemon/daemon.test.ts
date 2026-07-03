import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Waits for `marker` to appear in `stream`, reading incrementally so callers don't have to
 * guess a fixed startup delay. Used to gate on `runSchedulerLoop`'s "scheduler started" log
 * line, which is only emitted AFTER the SIGTERM/SIGINT handlers are registered — the pidfile
 * itself appears earlier (written before those handlers exist), so waiting on it instead would
 * race a SIGTERM against the daemon's default (handler-less) kill behavior.
 */
async function waitForStderrMarker(
    stream: ReadableStream<Uint8Array>,
    marker: string,
    timeoutMs = 5000
): Promise<boolean> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const timedOut = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });

    try {
        while (true) {
            const result = await Promise.race([reader.read(), deadline]);

            if (result === timedOut) {
                return false;
            }

            const { done, value } = result;

            if (value) {
                buffer += decoder.decode(value, { stream: true });

                if (buffer.includes(marker)) {
                    return true;
                }
            }

            if (done) {
                return false;
            }
        }
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

describe("daemon SIGTERM shutdown ordering", () => {
    test("PID file is created on start and removed once the scheduler has fully shut down", async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "daemon-test-"));
        const proc = Bun.spawn(["bun", "run", "src/daemon/daemon.ts"], {
            env: { ...process.env, GENESIS_TOOLS_DAEMON_DIR: tmpDir },
            stderr: "pipe",
        });

        const pidFile = `${tmpDir}/daemon.pid`;
        const ready = await waitForStderrMarker(proc.stderr, "[daemon] scheduler started");
        expect(ready).toBe(true);
        expect(existsSync(pidFile)).toBe(true);

        proc.kill("SIGTERM");
        await proc.exited;

        expect(existsSync(pidFile)).toBe(false);
    });
});

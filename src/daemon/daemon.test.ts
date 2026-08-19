import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { readPidRecord } from "@genesiscz/utils/process/pidfile";
import { attemptStaleTakeover, getDaemonPid, isDaemonCommand, verifyPidfileOwnership } from "./daemon";

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

describe("daemon pidfile atomic takeover", () => {
    let dir: string;
    let pidFile: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "daemon-takeover-test-"));
        pidFile = join(dir, "daemon.pid");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("exactly one of N concurrent racers wins a stale-pidfile takeover", async () => {
        // Regression test for the Jul 3 incident: a launchd respawn storm got
        // 31 daemon instances past a check-then-unlink-then-write pidfile
        // takeover within 8 seconds, and every one of them "won". The
        // content-verified rename takeover must guarantee exactly one winner —
        // rename alone is NOT enough (a late racer can rename the previous
        // winner's fresh pidfile; this exact test caught 2 winners without
        // the content check).
        writeFileSync(pidFile, "999999999"); // dead PID — eligible for takeover

        const RACER_COUNT = 12;
        const results = await Promise.all(
            Array.from({ length: RACER_COUNT }, () => attemptStaleTakeover(pidFile, "999999999"))
        );

        expect(results.filter((won) => won === true)).toHaveLength(1);

        expect(existsSync(pidFile)).toBe(true);
        // The winner rewrites the slot as an identity-bearing record, not the
        // bare number the loser validated as stale.
        expect(readPidRecord(pidFile)?.pid).toBe(process.pid);
        expect(readPidRecord(pidFile)?.command).toContain("bun");
        expect(readdirSync(dir)).toEqual(["daemon.pid"]);
    });

    test("a takeover that grabs a FRESH pidfile restores it and loses", async () => {
        // TOCTOU guard: the racer validated "999999999" as stale, but by the
        // time its rename lands, a live owner has re-claimed the slot. The
        // steal must detect the content mismatch, put the fresh file back,
        // and report defeat.
        writeFileSync(pidFile, "12345"); // a "fresh" owner (content ≠ what the racer validated)

        const won = await attemptStaleTakeover(pidFile, "999999999");

        expect(won).toBe(false);
        expect(readFileSync(pidFile, "utf-8").trim()).toBe("12345"); // restored, not clobbered
        expect(readdirSync(dir)).toEqual(["daemon.pid"]); // no temp litter
    });

    test("a recycled pid owned by an unrelated program reads as stale, not as a live daemon", async () => {
        // Regression test for the Aug 19 incident: the pidfile still held pid
        // 891 from a daemon that had died without cleanup, macOS had since
        // handed 891 to WiFiCloudAssetsXPCService, and `kill(pid, 0)` happily
        // confirmed "alive". Every launchd respawn then exited with
        // EXIT_ALREADY_RUNNING — 4284 restarts in ~12h with nothing polling.
        const foreign = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });

        try {
            writeFileSync(pidFile, String(foreign.pid));

            await env.testing.withOverrides({ GENESIS_TOOLS_DAEMON_DIR: dir }, () => {
                expect(getDaemonPid()).toBeNull();
            });
        } finally {
            foreign.kill();
            await foreign.exited;
        }
    });

    test("a live pid running a real daemon entrypoint still reads as the owner", async () => {
        // The negative control: the staleness check must not hand the pidfile
        // to a second daemon while the first one is still running.
        const proc = Bun.spawn(["bun", "run", "src/daemon/daemon.ts"], {
            env: { ...process.env, GENESIS_TOOLS_DAEMON_DIR: dir },
            stderr: "pipe",
        });

        try {
            expect(await waitForStderrMarker(proc.stderr, "[daemon] scheduler started")).toBe(true);

            await env.testing.withOverrides({ GENESIS_TOOLS_DAEMON_DIR: dir }, () => {
                expect(getDaemonPid()).toBe(proc.pid);
            });
        } finally {
            proc.kill("SIGTERM");
            await proc.exited;
        }
    });

    test("isDaemonCommand accepts every launch shape and rejects a recycled-pid stranger", () => {
        expect(isDaemonCommand("/Users/m/.bun/bin/bun run /repo/src/daemon/daemon.ts")).toBe(true);
        expect(isDaemonCommand("bun run /repo/src/daemon/index.ts start")).toBe(true);
        expect(isDaemonCommand("/usr/local/bin/tools daemon start")).toBe(true);
        expect(
            isDaemonCommand(
                "/System/Library/PrivateFrameworks/WiFiPolicy.framework/XPCServices/" +
                    "WiFiCloudAssetsXPCService.xpc/Contents/MacOS/WiFiCloudAssetsXPCService"
            )
        ).toBe(false);
        expect(isDaemonCommand("/usr/bin/sleep 30")).toBe(false);
    });

    test("verifyPidfileOwnership reports loss when the pidfile is stolen out from under us", () => {
        writeFileSync(pidFile, String(process.pid));
        expect(verifyPidfileOwnership(pidFile)).toBe(true);

        // Simulate a usurper stealing the pidfile (e.g. we lost a takeover
        // race we didn't know about, or the file was manually removed).
        writeFileSync(pidFile, "424242");
        expect(verifyPidfileOwnership(pidFile)).toBe(false);

        rmSync(pidFile);
        expect(verifyPidfileOwnership(pidFile)).toBe(false);
    });
});

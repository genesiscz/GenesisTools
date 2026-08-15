import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyPidState } from "@app/ai-proxy/lib/runtime";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";

/**
 * `down` sends SIGTERM/SIGKILL, which is irreversible and lands on whatever owns the pid
 * TODAY. These tests assert at that primitive: the spy records every real signal AND
 * throws, so a guarded path that reaches it fails loudly instead of passing quietly.
 */

const originalHome = env.get("GENESIS_TOOLS_HOME");
let pidState: ProxyPidState = { status: "none" };
let clearedRuntime = 0;

mock.module("@app/ai-proxy/lib/runtime", () => ({
    inspectProxyPid: () => pidState,
    clearRuntimeState: async () => {
        clearedRuntime += 1;
    },
    readRuntimeState: async () => ({}),
    writeRuntimeState: async () => {},
    readProxyPid: () => (pidState.status === "none" ? null : pidState.pid),
    writeProxyPid: () => {},
    clearProxyPid: () => {},
    resolveLiveProxyPid: () => (pidState.status === "live" ? pidState.pid : null),
    isAiProxyServeCommand: () => true,
}));

const { runAiProxyDown } = await import("@app/ai-proxy/lib/lifecycle");

interface KillSpy {
    signals: Array<{ pid: number; signal: unknown }>;
    restore: () => void;
}

/** Signal 0 is a liveness PROBE, not a kill — it stays real so isProcessAlive still works. */
function spyOnKill(): KillSpy {
    const original = process.kill.bind(process);
    const signals: Array<{ pid: number; signal: unknown }> = [];

    process.kill = ((pid: number, signal?: string | number) => {
        if (signal === 0) {
            return original(pid, 0);
        }

        signals.push({ pid, signal });
        throw new Error(`process.kill(${pid}, ${String(signal)}) must not be reached`);
    }) as typeof process.kill;

    return {
        signals,
        restore: () => {
            process.kill = original;
        },
    };
}

const cleanups: Array<() => void> = [];

function useTempHome(): void {
    const home = mkdtempSync(join(tmpdir(), "ai-proxy-lifecycle-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    resetAiProxyStorage();
    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    resetAiProxyStorage();
    pidState = { status: "none" };
    clearedRuntime = 0;

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("runAiProxyDown", () => {
    it("never signals a pid that belongs to another program", async () => {
        useTempHome();
        pidState = { status: "foreign", pid: 4242, command: "vim notes.md" };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(kill.signals).toEqual([]);
            expect(result.stopped).toBe(false);
            expect(result.message).toContain("another process");
        } finally {
            kill.restore();
        }
    });

    // The regression: `unverified` means alive but UNIDENTIFIABLE, and it used to fall
    // straight through to process.kill — the recycled-pid incident this guard exists for.
    it("never signals a pid whose identity could not be verified", async () => {
        useTempHome();
        pidState = { status: "unverified", pid: 4243 };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(kill.signals).toEqual([]);
            expect(result.stopped).toBe(false);
            expect(result.pid).toBe(4243);
            expect(result.message).toContain("could not be identified");
            // The record may still be ours, so it is NOT discarded.
            expect(clearedRuntime).toBe(0);
        } finally {
            kill.restore();
        }
    });

    it("never signals when nothing is recorded or the process is gone", async () => {
        useTempHome();
        const kill = spyOnKill();

        try {
            pidState = { status: "none" };
            expect((await runAiProxyDown()).stopped).toBe(false);

            pidState = { status: "dead", pid: 4244 };
            expect((await runAiProxyDown()).stopped).toBe(false);

            expect(kill.signals).toEqual([]);
        } finally {
            kill.restore();
        }
    });

    // The other half of the guard: a CONFIRMED proxy must still be stoppable.
    it("does signal a confirmed-live proxy", async () => {
        useTempHome();
        pidState = { status: "live", pid: 4245, command: "tools ai-proxy serve" };
        const kill = spyOnKill();

        try {
            await runAiProxyDown();

            expect(kill.signals[0]).toEqual({ pid: 4245, signal: "SIGTERM" });
        } finally {
            kill.restore();
        }
    });
});

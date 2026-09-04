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

/**
 * The launchd module talks to the REAL `~/Library/LaunchAgents` and the REAL
 * `launchctl`. Left unmocked, running this suite on a machine where the agent
 * is installed would boot out the developer's own proxy. It is mocked in full,
 * and `bootouts` is the spy that proves ordering: `down` must unload the agent
 * BEFORE it signals, or KeepAlive restarts what we just killed.
 */
let launchdInstalled = false;
let installs = 0;
const bootouts: string[] = [];

mock.module("@app/ai-proxy/lib/launchd", () => ({
    AI_PROXY_LAUNCHD_LABEL: "com.genesis-tools.ai-proxy",
    aiProxyPlistPath: () => "/tmp/test-com.genesis-tools.ai-proxy.plist",
    isAiProxyLaunchdInstalled: () => launchdInstalled,
    installAiProxyLaunchd: async () => {
        installs += 1;
        return "/tmp/test-com.genesis-tools.ai-proxy.plist";
    },
    uninstallAiProxyLaunchd: async () => true,
    startAiProxyLaunchd: async () => {},
    stopAiProxyLaunchd: async () => {
        bootouts.push("bootout");
    },
    proxyEntryPath: () => "/tmp/ai-proxy/index.ts",
    toolsRoot: () => "/tmp",
}));

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
    isAiProxyServeCommand: () => ownerIsProxy,
}));

/**
 * install-launchd asks the port who owns it. The owner is faked here; the pid
 * inside it is a REAL child of the test, so isProcessAlive and the SIGTERM
 * stay real.
 */
let ownerIsProxy = true;
let portOwner: { pid: number; command: string } | null = null;
const network = await import("@genesiscz/utils/network");

mock.module("@genesiscz/utils/network", () => ({
    ...network,
    getPortOwner: async () => portOwner,
}));

const { runAiProxyDown, runAiProxyInstallLaunchd } = await import("@app/ai-proxy/lib/lifecycle");

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
    launchdInstalled = false;
    installs = 0;
    ownerIsProxy = true;
    portOwner = null;
    bootouts.length = 0;

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

describe("runAiProxyDown — launchd path", () => {
    // The regression this guards: KeepAlive answers a bare SIGTERM by restarting
    // the proxy, so a `down` that only signals reports success and undoes itself.
    it("unloads the agent BEFORE it signals the process", async () => {
        useTempHome();
        launchdInstalled = true;
        pidState = { status: "live", pid: 5101, command: "tools ai-proxy serve" };
        const kill = spyOnKill();

        try {
            await runAiProxyDown();

            expect(bootouts).toEqual(["bootout"]);
            expect(kill.signals[0]).toEqual({ pid: 5101, signal: "SIGTERM" });
        } finally {
            kill.restore();
        }
    });

    // The bootout is what stopped it, so "not running" would hide the work done.
    it("reports stopped when the bootout already killed the process", async () => {
        useTempHome();
        launchdInstalled = true;
        pidState = { status: "dead", pid: 5102 };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(bootouts).toEqual(["bootout"]);
            expect(kill.signals).toEqual([]);
            expect(result.stopped).toBe(true);
            expect(result.message).toContain("com.genesis-tools.ai-proxy");
        } finally {
            kill.restore();
        }
    });

    // The negative control: no agent installed means launchctl is never touched.
    it("never touches launchctl when no agent is installed", async () => {
        useTempHome();
        launchdInstalled = false;
        pidState = { status: "live", pid: 5103, command: "tools ai-proxy serve" };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(bootouts).toEqual([]);
            expect(kill.signals[0]).toEqual({ pid: 5103, signal: "SIGTERM" });
            expect(result.message).not.toContain("launchd");
        } finally {
            kill.restore();
        }
    });

    // Guarding a real refusal must not start booting out on the way past it.
    it("still refuses a foreign pid, and does not leave the agent loaded", async () => {
        useTempHome();
        launchdInstalled = true;
        pidState = { status: "foreign", pid: 5104, command: "vim notes.md" };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(kill.signals).toEqual([]);
            expect(bootouts).toEqual(["bootout"]);
            expect(result.message).toContain("another process");
            // The bootout IS the stop here, and the caller must be told it happened:
            // reporting `stopped: false` with no mention of the unload read as
            // "down did nothing" while the launchd proxy was in fact gone.
            expect(result.stopped).toBe(true);
            expect(result.message).toContain("com.genesis-tools.ai-proxy");
        } finally {
            kill.restore();
        }
    });

    // The unverified branch signals nothing, so the unload is the only thing that
    // happened, and the message is the only place the user can learn it.
    it("names the unloaded agent when it refuses an unverifiable pid", async () => {
        useTempHome();
        launchdInstalled = true;
        pidState = { status: "unverified", pid: 5105 };
        const kill = spyOnKill();

        try {
            const result = await runAiProxyDown();

            expect(kill.signals).toEqual([]);
            expect(bootouts).toEqual(["bootout"]);
            expect(result.stopped).toBe(false);
            expect(result.message).toContain("com.genesis-tools.ai-proxy");
        } finally {
            kill.restore();
        }
    });
});

// runAiProxyInstallLaunchd refuses to run anywhere but macOS before it looks at the port.
describe.skipIf(process.platform !== "darwin")("runAiProxyInstallLaunchd — port owner gate", () => {
    it("refuses to install over a listener that is not ai-proxy, and signals nothing", async () => {
        useTempHome();
        const holder = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
        portOwner = { pid: holder.pid, command: "node something-else serve" };
        ownerIsProxy = false;
        const spy = spyOnKill();

        try {
            await expect(runAiProxyInstallLaunchd()).rejects.toThrow(/not ai-proxy/);
            expect(spy.signals).toEqual([]);
            expect(installs).toBe(0);
        } finally {
            spy.restore();
            holder.kill();
        }
    });

    it("aborts instead of installing when the manual proxy survives SIGTERM", async () => {
        useTempHome();
        // The pid record is gone, so `down` has nothing to signal; the owner
        // itself ignores SIGTERM the way a wedged proxy would.
        const holder = Bun.spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
            stdout: "ignore",
            stderr: "ignore",
        });
        await Bun.sleep(400);
        portOwner = { pid: holder.pid, command: "bun src/ai-proxy/index.ts serve" };
        pidState = { status: "none" };

        try {
            await expect(runAiProxyInstallLaunchd()).rejects.toThrow(/still holds port/);
            expect(installs).toBe(0);
        } finally {
            holder.kill("SIGKILL");
        }
    }, 10_000);
});

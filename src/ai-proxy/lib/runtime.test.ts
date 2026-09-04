import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    inspectProxyPid,
    isAiProxyServeCommand,
    readProxyPid,
    registerServingProcess,
    writeProxyPid,
} from "@app/ai-proxy/lib/runtime";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";

const originalHome = env.get("GENESIS_TOOLS_HOME");
const cleanups: Array<() => void> = [];

/** Above macOS/Linux pid ceilings, so `kill(pid, 0)` is guaranteed ESRCH. */
const NEVER_ALLOCATED_PID = 4_194_304;

function useTempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ai-proxy-runtime-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    resetAiProxyStorage();
    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    return home;
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    resetAiProxyStorage();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("isAiProxyServeCommand", () => {
    it("matches the command line spawnProxy actually produces", () => {
        expect(
            isAiProxyServeCommand("bun run /Users/x/Projects/GenesisTools/src/ai-proxy/index.ts serve --port 8317")
        ).toBe(true);
    });

    it("matches a hand-started `tools ai-proxy serve`", () => {
        expect(isAiProxyServeCommand("tools ai-proxy serve")).toBe(true);
    });

    it("rejects the process that inherited the pid in the 2026-08 incident", () => {
        expect(
            isAiProxyServeCommand("/Users/x/.cache/darwinkit/latest/DarwinKit.app/Contents/MacOS/darwinkit serve")
        ).toBe(false);
    });

    it("rejects our own short-lived non-serve invocations", () => {
        expect(isAiProxyServeCommand("bun run /Users/x/GenesisTools/src/ai-proxy/index.ts status")).toBe(false);
        expect(isAiProxyServeCommand("bun run /Users/x/GenesisTools/src/ai-proxy/index.ts up")).toBe(false);
    });

    it("rejects an empty command line", () => {
        expect(isAiProxyServeCommand("")).toBe(false);
    });
});

describe("registerServingProcess", () => {
    it("records the pid when serving the configured port", async () => {
        useTempHome();

        expect(await registerServingProcess({ serving: 8317, configured: 8317 })).toBe(true);
        expect(readProxyPid()).toBe(process.pid);
    });

    it("leaves the live proxy's record alone when serving a debug port", async () => {
        // `serve --port 8318` beside a launchd-managed 8317 used to overwrite the
        // record, after which one `down` stopped both proxies.
        useTempHome();
        writeProxyPid(NEVER_ALLOCATED_PID);

        expect(await registerServingProcess({ serving: 8318, configured: 8317 })).toBe(false);
        expect(readProxyPid()).toBe(NEVER_ALLOCATED_PID);
    });
});

describe("inspectProxyPid", () => {
    it("reports none when no pid was ever recorded", () => {
        useTempHome();
        expect(inspectProxyPid()).toEqual({ status: "none" });
    });

    it("reports dead when the recorded process is gone", () => {
        useTempHome();
        writeProxyPid(NEVER_ALLOCATED_PID);

        expect(inspectProxyPid()).toEqual({ status: "dead", pid: NEVER_ALLOCATED_PID });
    });

    it("reports foreign when the pid is alive but is a different program", () => {
        useTempHome();
        // The test runner itself: definitely alive, definitely not an ai-proxy serve.
        writeProxyPid(process.pid);

        const state = inspectProxyPid();
        expect(state.status).toBe("foreign");
    });

    it("reports live for a real running ai-proxy serve process", async () => {
        const home = useTempHome();
        const entry = join(home, "ai-proxy", "index.ts");
        mkdirSync(join(home, "ai-proxy"), { recursive: true });
        writeFileSync(entry, "await Bun.sleep(30_000);\n");

        const proc = Bun.spawn(["bun", "run", entry, "serve"], { stdout: "ignore", stderr: "ignore" });
        cleanups.push(() => proc.kill());
        writeProxyPid(proc.pid);

        // `ps` only sees the process once the OS has execed it.
        await Bun.sleep(300);

        const state = inspectProxyPid();
        expect(state.status).toBe("live");
    });
});

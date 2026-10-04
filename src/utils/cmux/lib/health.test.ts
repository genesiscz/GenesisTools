import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCmuxAccessDenied } from "@genesiscz/utils/cmux/lib/access-denied";
import { type CmuxHealth, CmuxUnresponsiveError, classifyCmuxHealth } from "@genesiscz/utils/cmux/lib/health";
import { logger } from "@genesiscz/utils/logger";
import { runCmuxJSON, runCmuxOk } from "./cli";

describe("classifyCmuxHealth", () => {
    test("ping + identify ok is healthy regardless of app detection", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: true, identifyOk: true })).toBe("healthy");
        expect(classifyCmuxHealth({ appRunning: false, pingOk: true, identifyOk: true })).toBe("healthy");
    });

    test("ping ok but identify starved is the UI livelock signature", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: true, identifyOk: false })).toBe("ui-starved");
    });

    test("dead socket with a running app is socket-dead", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: false, identifyOk: false })).toBe("socket-dead");
    });

    test("dead socket without an app process is not-running", () => {
        expect(classifyCmuxHealth({ appRunning: false, pingOk: false, identifyOk: false })).toBe("not-running");
    });

    // Regression test: #446 item 2 — a caller cmux refuses (not started inside
    // a cmux pane) read as a dead socket and told the user to restart cmux.
    test("access denied takes priority over the dead-socket classification", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: false, identifyOk: false, accessDenied: true })).toBe(
            "access-denied"
        );
    });
});

describe("isCmuxAccessDenied", () => {
    test("recognizes cmux's own access-denied stderr", () => {
        expect(
            isCmuxAccessDenied("Error: ERROR: Access denied - only processes started inside cmux can connect\n")
        ).toBe(true);
    });

    test("is false for an unrelated error", () => {
        expect(isCmuxAccessDenied("Error: connection refused")).toBe(false);
    });

    test("is false for undefined", () => {
        expect(isCmuxAccessDenied(undefined)).toBe(false);
    });
});

describe("CmuxUnresponsiveError", () => {
    test("names the real cause for access-denied instead of suggesting a restart", () => {
        const accessDeniedDetail = "Error: ERROR: Access denied - only processes started inside cmux can connect";
        const health: CmuxHealth = {
            state: "access-denied",
            appPid: 10956,
            probes: {
                ping: { ok: false, ms: 21, detail: accessDeniedDetail },
                identify: { ok: false, ms: 0, detail: "skipped (ping failed)" },
            },
        };

        const err = new CmuxUnresponsiveError("cmux live snapshot", health);

        expect(err.message).toContain("run this from a cmux pane");
        expect(err.message).not.toContain("restart");
    });
});

/**
 * Overwrites the SAME fake `cmux` binary's content, rather than installing a fresh
 * one per call: `resolveCmuxPath()` caches the resolved path after the first
 * successful `Bun.which` lookup, so a second `mkdtempSync` dir prepended to PATH
 * later in the same test file is silently ignored once the cache is warm.
 */
let fakeCmuxBinPath: string | null = null;

function writeFakeCmux(script: string): void {
    if (!fakeCmuxBinPath) {
        const dir = mkdtempSync(join(tmpdir(), "fake-cmux-access-denied-"));
        fakeCmuxBinPath = join(dir, "cmux");
        process.env.PATH = `${dir}:${process.env.PATH}`;
    }

    writeFileSync(fakeCmuxBinPath, script);
    chmodSync(fakeCmuxBinPath, 0o755);
}

// Regression test: #446 item 2 — every non-zero cmux exit, including the
// expected-and-explained "Access denied - only processes started inside cmux
// can connect", logged a raw structured ERROR dump before the friendly report.
describe("runCmuxJSON / runCmuxOk: access denied is quiet", () => {
    test("logs access denied at debug, not error, for runCmuxJSON", async () => {
        writeFakeCmux(
            '#!/bin/sh\necho "Error: ERROR: Access denied - only processes started inside cmux can connect" >&2\nexit 1\n'
        );
        const errorSpy = spyOn(logger, "error");
        const debugSpy = spyOn(logger, "debug");

        await expect(runCmuxJSON(["list-windows"])).rejects.toThrow();

        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        debugSpy.mockRestore();
    });

    test("logs access denied at debug, not error, for runCmuxOk", async () => {
        writeFakeCmux(
            '#!/bin/sh\necho "Error: ERROR: Access denied - only processes started inside cmux can connect" >&2\nexit 1\n'
        );
        const errorSpy = spyOn(logger, "error");

        await expect(runCmuxOk(["identify"])).rejects.toThrow();

        expect(errorSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    // Negative control: an unrelated, genuine failure still gets the full ERROR
    // detail — only the recognized access-denied case is quieted.
    test("still logs a genuine failure at error level", async () => {
        writeFakeCmux('#!/bin/sh\necho "boom: something else broke" >&2\nexit 1\n');
        const errorSpy = spyOn(logger, "error");

        await expect(runCmuxJSON(["list-windows"])).rejects.toThrow();

        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

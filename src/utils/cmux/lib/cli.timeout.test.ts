import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CMUX_TIMEOUT_MS, runCmux, runCmuxJSON, runCmuxOk } from "./cli";

/**
 * Regression test: `runCmux` gained a kill + SIGKILL escalation behind an opt-in
 * `timeoutMs`, but the two wrappers every consumer actually uses — runCmuxJSON
 * and runCmuxOk — neither accepted nor forwarded it. 37 awaited calls across 15
 * files could not pass one, so a wedged cmux hung them forever. On a branch
 * whose whole subject is cmux livelock, the safety belonged in the default.
 */
function fakeCmuxOnPath(script: string): void {
    const dir = mkdtempSync(join(tmpdir(), "fake-cmux-"));
    const bin = join(dir, "cmux");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
}

describe("runCmux timeout", () => {
    test("a hung invocation is killed rather than awaited forever", async () => {
        fakeCmuxOnPath("#!/bin/sh\nsleep 30\n");

        const started = Date.now();
        const result = await runCmux(["anything"], { timeoutMs: 300 });
        const elapsed = Date.now() - started;

        expect(result.timedOut).toBe(true);
        // Generous bound: the point is that it returns at all, not that it is fast.
        expect(elapsed).toBeLessThan(10_000);
    });

    test("the wrappers forward the option, so every caller can bound its own call", async () => {
        fakeCmuxOnPath("#!/bin/sh\nsleep 30\n");

        await expect(runCmuxOk(["anything"], { timeoutMs: 300 })).rejects.toThrow();
        await expect(runCmuxJSON(["anything"], { timeoutMs: 300 })).rejects.toThrow();
    });

    test("there is a default, so a caller that passes nothing is still bounded", () => {
        expect(DEFAULT_CMUX_TIMEOUT_MS).toBeGreaterThan(0);
        expect(Number.isFinite(DEFAULT_CMUX_TIMEOUT_MS)).toBe(true);
    });
});

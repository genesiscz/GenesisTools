import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { type BoundedCommandResult, boundedCommand } from "./bounded-command";

let dir: string | undefined;
let survivor: number | undefined;

afterEach(() => {
    if (survivor && isProcessAlive(survivor)) {
        // pid-verified: the sleep this test started and recorded itself, still running.
        process.kill(survivor, "SIGKILL");
    }

    if (dir) {
        rmSync(dir, { recursive: true, force: true });
    }

    survivor = undefined;
    dir = undefined;
});

/**
 * A SIGKILLed orphan stays a zombie until init reaps it, and `kill(pid, 0)` still succeeds on a zombie.
 * CI 2026-10-09 failed 3 of 20 runs on exactly that: the descendant was dead, its reaper had not run yet.
 */
function isRunning(pid: number): boolean {
    if (!isProcessAlive(pid)) {
        return false;
    }

    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
        .stdout.toString()
        .trim();

    return state !== "" && !state.startsWith("Z");
}

async function stopsRunningWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (isRunning(pid)) {
        if (Date.now() >= deadline) {
            return false;
        }

        await Bun.sleep(25);
    }

    return true;
}

/**
 * Runs `script` (which must write its TERM-ignoring descendant's pid to the given file) until that
 * descendant got going before the deadline. A loaded machine can start the shell after a 150 ms
 * deadline already fired; then nothing was ever created, and the run is repeated with a longer one.
 */
async function runWithDescendant(
    script: (pidFile: string) => string
): Promise<{ result: BoundedCommandResult; pid: number }> {
    dir = mkdtempSync(join(tmpdir(), "bounded-command-"));

    for (const timeoutMs of [150, 600, 2000]) {
        const pidFile = join(dir, `descendant-${timeoutMs}.pid`);
        const result = await boundedCommand({ command: ["sh", "-c", script(pidFile)], timeoutMs });

        if (existsSync(pidFile)) {
            survivor = Number(readFileSync(pidFile, "utf8").trim());
            return { result, pid: survivor };
        }
    }

    throw new Error("The descendant never started, even with a 2 s deadline.");
}

test("a deadline kills a TERM-ignoring descendant even after the group leader exited", async () => {
    const { result, pid } = await runWithDescendant(
        (pidFile) => `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 5' & wait`
    );

    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(await stopsRunningWithin(pid, 2000)).toBe(true);
}, 10_000);

// Regression test: "close" cleared the SIGKILL escalation, so a descendant that ignored SIGTERM and did not hold our pipes outlived its deadline.
test("a deadline kills a TERM-ignoring descendant that let go of our pipes", async () => {
    const { result, pid } = await runWithDescendant(
        (pidFile) => `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 5' </dev/null >/dev/null 2>&1 & wait`
    );

    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(await stopsRunningWithin(pid, 2000)).toBe(true);
}, 10_000);

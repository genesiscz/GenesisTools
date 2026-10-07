import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { boundedCommand } from "./bounded-command";

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

test("a deadline kills a TERM-ignoring descendant even after the group leader exited", async () => {
    dir = mkdtempSync(join(tmpdir(), "bounded-command-"));
    const pidFile = join(dir, "descendant.pid");

    const result = await boundedCommand({
        command: ["sh", "-c", `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 5' & wait`],
        timeoutMs: 150,
    });

    survivor = Number(readFileSync(pidFile, "utf8").trim());
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(isProcessAlive(survivor)).toBe(false);
});

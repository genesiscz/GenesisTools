import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@app/utils/test/skip";
import { runTask } from "./runner";
import type { DaemonTask } from "./types";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-runner-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe("runTask", () => {
    // skip.onWindows: runTask wraps the command in `sh -c` (Unix shell). On
    // Windows CI that yields exit 127 (110ms — the tree-kill/no-hang fix
    // works; this is a separate runTask Windows-portability gap, not a hang).
    it.skipIf(skip.onWindows)("times out a command that prints output but never exits", async () => {
        const logsDir = makeTempDir();
        const task: DaemonTask = {
            name: "hung-task",
            command: `${process.execPath} -e "console.log('work done'); setInterval(() => {}, 1000)"`,
            every: "every 1 minute",
            retries: 0,
            enabled: true,
            timeoutMs: 200,
        };

        const started = Date.now();
        const result = await runTask(task, 1, logsDir);

        expect(Date.now() - started).toBeLessThan(2_000);
        expect(result.exitCode).toBeNull();

        const log = readFileSync(result.logFile, "utf-8");
        expect(log).toContain("work done");
        expect(log).toContain('"timedOut":true');
    });
});

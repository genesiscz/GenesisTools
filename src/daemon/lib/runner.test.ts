import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";
import { runTask, TASK_SIGTERM_CLEANUP_MS, TASK_SIGTERM_GRACE_MS, taskPath } from "./runner";
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

describe("taskPath", () => {
    it("puts the checkout first, so a bare `tools` task resolves, and adds the system bin folders", () => {
        const repo = resolve(import.meta.dir, "../../..");
        expect(existsSync(join(repo, "tools"))).toBe(true);
        expect(taskPath("/usr/bin:/bin").split(":")).toEqual([repo, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    });

    it("does not repeat a folder the inherited PATH already has", () => {
        expect(
            taskPath("/usr/sbin:/usr/bin")
                .split(":")
                .filter((dir) => dir === "/usr/sbin")
        ).toHaveLength(1);
    });
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

    // The usage poll releases its Codex homes on SIGTERM; the runner used to SIGKILL 500 ms later, and 123 of
    // 300 timed-out polls escalated to SIGKILL (2026-10-05..12). A cleanup inside the agreed budget must finish.
    it.skipIf(skip.onWindows)("waits out a SIGTERM cleanup that takes longer than half a second", async () => {
        const logsDir = makeTempDir();
        const timeoutMs = 400;
        const task: DaemonTask = {
            name: "slow-cleanup-task",
            command: `trap 'sleep 0.6; echo cleaned; exit 0' TERM; echo ready; while :; do sleep 0.05; done`,
            every: "every 1 minute",
            retries: 0,
            enabled: true,
            timeoutMs,
        };

        const started = Date.now();
        const result = await runTask(task, 1, logsDir);
        const elapsedMs = Date.now() - started;

        // Only stdout records: the meta record repeats the command, which contains both words.
        const stdout = readFileSync(result.logFile, "utf-8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line, { strict: true }) as { type: string; data?: string })
            .filter((record) => record.type === "stdout")
            .map((record) => record.data);
        expect(stdout).toEqual(["ready", "cleaned"]);
        expect(result.exitCode).toBeNull();
        expect(TASK_SIGTERM_GRACE_MS).toBeGreaterThan(TASK_SIGTERM_CLEANUP_MS);
        expect(elapsedMs).toBeLessThan(timeoutMs + TASK_SIGTERM_GRACE_MS);
    });
});

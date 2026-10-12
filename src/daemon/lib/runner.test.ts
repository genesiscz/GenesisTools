import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";
import { runTask, TASK_SIGTERM_CLEANUP_MS, TASK_SIGTERM_GRACE_MS, taskArgv, taskPath } from "./runner";
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

describe("taskArgv", () => {
    it("runs low under background QoS, normal as the daemon runs, and high out of background", () => {
        expect(taskArgv("echo hi", "low", true)).toEqual(["/usr/sbin/taskpolicy", "-b", "sh", "-c", "echo hi"]);
        expect(taskArgv("echo hi", "normal", true)).toEqual(["sh", "-c", "echo hi"]);
        expect(taskArgv("echo hi", "high", true).slice(0, 2)).toEqual(["/usr/bin/perl", "-e"]);
        expect(taskArgv("echo hi", "high", true).slice(3)).toEqual(["sh", "-c", "echo hi"]);
        expect(taskArgv("echo hi", "high", false)).toEqual(["sh", "-c", "echo hi"]);
    });

    it.skipIf(process.platform !== "darwin")(
        "a high task started from a background process is not throttled, a low one is",
        async () => {
            // A daemon from a Background plist (before Standard); `taskpolicy -b` puts this parent in the same state.
            const priorityOf = async (priority: "high" | "low"): Promise<number> => {
                const proc = Bun.spawn(["/usr/sbin/taskpolicy", "-b", ...taskArgv("ps -o pri= -p $$", priority)], {
                    env: process.env,
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
                return Number(stdout.trim());
            };

            // PRI 4 is darwin background; an unthrottled process sits at the default 31.
            expect(await priorityOf("low")).toBe(4);
            expect(await priorityOf("high")).toBeGreaterThan(4);
        }
    );
});

describe("run log meta", () => {
    it("records why the run happened, its priority and the slot it stands in for", async () => {
        const logsBaseDir = makeTempDir();
        const task: DaemonTask = {
            name: "meta-task",
            command: "true",
            every: "every day at 03:00",
            retries: 0,
            enabled: true,
        };
        const result = await runTask(task, 1, logsBaseDir, {
            reason: "catch-up",
            priority: "low",
            scheduledFor: new Date("2026-10-12T01:00:00.000Z"),
        });
        const meta = SafeJSON.parse(readFileSync(result.logFile, "utf8").split("\n")[0] ?? "{}", { strict: true });

        expect(meta).toMatchObject({
            type: "meta",
            reason: "catch-up",
            priority: "low",
            scheduledFor: "2026-10-12T01:00:00.000Z",
        });
        expect(result.exitCode).toBe(0);
    });
});

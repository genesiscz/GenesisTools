import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("tail --follow --exit-on-match PATTERN exits on first match (F2)", async () => {
    const SESSION = `exit-match-${Date.now()}`;

    const producer = spawn(
        "bun",
        [
            TASK_TOOL,
            "task",
            "run",
            "--session",
            SESSION,
            "--no-tty",
            "--",
            "bash",
            "-c",
            "echo noise1; sleep 0.5; echo SENTINEL_FOUND; sleep 2; echo more",
        ],
        { detached: true, stdio: "ignore" }
    );
    producer.unref();

    await new Promise((r) => setTimeout(r, 800));

    const waitStart = Date.now();
    const watcher = spawnSync(
        "bun",
        [TASK_TOOL, "task", "tail", "--session", SESSION, "--follow", "--raw", "--exit-on-match", "SENTINEL_FOUND"],
        { encoding: "utf-8", timeout: 5000 }
    );
    const elapsed = Date.now() - waitStart;

    expect(watcher.status).toBe(0);
    expect(elapsed).toBeLessThan(2000);
    expect(watcher.stdout).toContain("SENTINEL_FOUND");

    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", SESSION]);
});

test("tail --follow --propagate-exit propagates session exit code (F3)", async () => {
    const SESSION = `prop-exit-${Date.now()}`;

    const producer = spawn(
        "bun",
        [
            TASK_TOOL,
            "task",
            "run",
            "--session",
            SESSION,
            "--no-tty",
            "--",
            "bash",
            "-c",
            "echo working; sleep 0.3; exit 42",
        ],
        { detached: true, stdio: "ignore" }
    );
    producer.unref();

    await new Promise((r) => setTimeout(r, 800));

    const watcher = spawnSync(
        "bun",
        [TASK_TOOL, "task", "tail", "--session", SESSION, "--follow", "--propagate-exit"],
        { encoding: "utf-8", timeout: 5000 }
    );

    expect(watcher.status).toBe(42);
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", SESSION]);
});

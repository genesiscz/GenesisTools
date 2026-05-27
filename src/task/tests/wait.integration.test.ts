import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("wait --exit-on-match exits 0 on first pattern match (F1)", async () => {
    const S = `wait-match-${Date.now()}`;
    spawn(
        "bun",
        [
            TASK_TOOL,
            "task",
            "run",
            "--session",
            S,
            "--no-tty",
            "--",
            "bash",
            "-c",
            "echo a; sleep 0.5; echo Bundled in 234ms; sleep 5",
        ],
        { detached: true, stdio: "ignore" }
    ).unref();

    await new Promise((r) => setTimeout(r, 200));

    const start = Date.now();
    const r = spawnSync(
        "bun",
        [TASK_TOOL, "task", "wait", "--session", S, "--exit-on-match", "Bundled", "--timeout", "10"],
        { encoding: "utf-8", timeout: 12000 }
    );
    const elapsed = Date.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(3000);
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", S]);
});

test("wait --timeout exits non-zero on deadline (F1)", async () => {
    const S = `wait-timeout-${Date.now()}`;
    spawn(
        "bun",
        [TASK_TOOL, "task", "run", "--session", S, "--no-tty", "--", "bash", "-c", "sleep 30"],
        { detached: true, stdio: "ignore" }
    ).unref();

    await new Promise((r) => setTimeout(r, 200));

    const r = spawnSync(
        "bun",
        [TASK_TOOL, "task", "wait", "--session", S, "--exit-on-match", "NEVER_APPEARS", "--timeout", "2"],
        { encoding: "utf-8", timeout: 5000 }
    );

    expect(r.status).not.toBe(0);
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", S]);
});

test("wait without --exit-on-match waits for session exit + --propagate-exit (F1)", async () => {
    const S = `wait-exit-${Date.now()}`;
    spawn(
        "bun",
        [TASK_TOOL, "task", "run", "--session", S, "--no-tty", "--", "bash", "-c", "sleep 0.5; exit 17"],
        { detached: true, stdio: "ignore" }
    ).unref();

    await new Promise((r) => setTimeout(r, 200));

    const r = spawnSync(
        "bun",
        [TASK_TOOL, "task", "wait", "--session", S, "--timeout", "10", "--propagate-exit"],
        { encoding: "utf-8", timeout: 12000 }
    );

    expect(r.status).toBe(17);
    spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", S]);
});

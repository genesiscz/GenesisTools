import { expect, test } from "bun:test";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const env = setupTaskIntegrationHome();

test("tail --follow --exit-on-match PATTERN exits on first match (F2)", async () => {
    const SESSION = `exit-match-${Date.now()}`;

    await withTaskSession(env, SESSION, async () => {
        env.taskSpawn(
            [
                "run",
                "--session",
                SESSION,
                "--no-tty",
                "--",
                "bash",
                "-c",
                "echo noise1; sleep 0.5; echo SENTINEL_FOUND; sleep 30; echo more",
            ],
            { detached: true, stdio: "ignore" }
        ).unref();

        await new Promise((r) => setTimeout(r, 800));

        const waitStart = Date.now();
        const watcher = env.task(
            ["tail", "--session", SESSION, "--follow", "--raw", "--exit-on-match", "SENTINEL_FOUND"],
            { timeout: 25000 }
        );
        const elapsed = Date.now() - waitStart;

        expect(watcher.code).toBe(0);
        // Generous bound: the decoy session sleeps 30s after the sentinel, so
        // finishing well under that proves tail exited on match. Tight bounds
        // flake under the CI `bun test --parallel` subprocess contention.
        expect(elapsed).toBeLessThan(20000);
        expect(watcher.stdout).toContain("SENTINEL_FOUND");
    });
}, 30_000);

test("tail --follow --propagate-exit propagates session exit code (F3)", async () => {
    const SESSION = `prop-exit-${Date.now()}`;

    await withTaskSession(env, SESSION, async () => {
        env.taskSpawn(
            ["run", "--session", SESSION, "--no-tty", "--", "bash", "-c", "echo working; sleep 0.3; exit 42"],
            { detached: true, stdio: "ignore" }
        ).unref();

        await new Promise((r) => setTimeout(r, 800));

        const watcher = env.task(["tail", "--session", SESSION, "--follow", "--propagate-exit"], { timeout: 25000 });

        expect(watcher.code).toBe(42);
    });
}, 30_000);

import { expect, test } from "bun:test";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const env = setupTaskIntegrationHome();

test("wait --exit-on-match exits 0 on first pattern match (F1)", async () => {
    const S = `wait-match-${Date.now()}`;

    await withTaskSession(env, S, async () => {
        env.taskSpawn(
            [
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

        await new Promise((r) => setTimeout(r, 800));

        const start = Date.now();
        const r = env.task(["wait", "--session", S, "--exit-on-match", "Bundled", "--timeout", "10"], {
            timeout: 12000,
        });
        const elapsed = Date.now() - start;

        expect(r.code).toBe(0);
        expect(elapsed).toBeLessThan(3000);
    });
});

test("wait --timeout exits non-zero on deadline (F1)", async () => {
    const S = `wait-timeout-${Date.now()}`;

    await withTaskSession(env, S, async () => {
        env.taskSpawn(["run", "--session", S, "--no-tty", "--", "bash", "-c", "sleep 30"], {
            detached: true,
            stdio: "ignore",
        }).unref();

        await new Promise((r) => setTimeout(r, 800));

        const r = env.task(["wait", "--session", S, "--exit-on-match", "NEVER_APPEARS", "--timeout", "2"], {
            timeout: 5000,
        });

        expect(r.code).not.toBe(0);
    });
});

test("wait without --exit-on-match waits for session exit + --propagate-exit (F1)", async () => {
    const S = `wait-exit-${Date.now()}`;

    await withTaskSession(env, S, async () => {
        env.taskSpawn(["run", "--session", S, "--no-tty", "--", "bash", "-c", "sleep 0.5; exit 17"], {
            detached: true,
            stdio: "ignore",
        }).unref();

        await new Promise((r) => setTimeout(r, 800));

        const r = env.task(["wait", "--session", S, "--timeout", "10", "--propagate-exit"], { timeout: 12000 });

        expect(r.code).toBe(17);
    });
});

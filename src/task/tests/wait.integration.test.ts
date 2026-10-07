import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitForSession as waitForSessionRecord } from "@app/task/lib/wait-for-session";
import { env as processEnv } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { setupTaskIntegrationHome, waitForSession, withTaskSession } from "./task-integration-env";

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

        await waitForSession(env, S);

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

        await waitForSession(env, S);

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

        await waitForSession(env, S);

        const r = env.task(["wait", "--session", S, "--timeout", "10", "--propagate-exit"], { timeout: 12000 });

        expect(r.code).toBe(17);
    });
});

test("wait observes terminal records appended across snapshot startup", async () => {
    await processEnv.testing.withOverrides({ GENESIS_TOOLS_HOME: env.homeDir }, async () => {
        for (const kind of ["exit", "match"] as const) {
            const session = `wait-boundary-${kind}-${Date.now()}`;
            const path = join(env.sessionsDir(), `${session}.jsonl`);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "");
            const appended =
                kind === "exit"
                    ? { type: "exit", code: 23, durationMs: 1, ts: "2026-10-06T00:00:00.000Z" }
                    : { type: "line", seq: 1, out: "stdout", ts: 1, text: "boundary-ready" };

            let sawBuffered = false;
            let markBuffered: () => void = () => {};
            const buffered = new Promise<void>((resolve) => {
                markBuffered = resolve;
            });
            const result = await waitForSessionRecord(
                {
                    session,
                    waitForExit: kind === "exit",
                    exitOnMatch: kind === "match" ? /boundary-ready/ : undefined,
                    timeoutMs: 2_000,
                },
                {
                    // Return the (empty) snapshot only once the tailer has delivered the appended
                    // record into the startup buffer, so this exercises buffering, not the live path.
                    readExisting: async () => {
                        appendFileSync(path, `${SafeJSON.stringify(appended, { jsonl: true })}\n`);
                        await Promise.race([buffered, Bun.sleep(1_500)]);
                        return [];
                    },
                    onBuffered: () => {
                        sawBuffered = true;
                        markBuffered();
                    },
                }
            );

            expect(sawBuffered).toBe(true);

            expect(result).toEqual(
                kind === "exit"
                    ? { reason: "session-exit", sessionExitCode: 23 }
                    : { reason: "match", matchedLine: "boundary-ready" }
            );
        }
    });
});

test("wait returns its timeout while the snapshot read is still stalled", async () => {
    await processEnv.testing.withOverrides({ GENESIS_TOOLS_HOME: env.homeDir }, async () => {
        const session = `wait-stalled-read-${Date.now()}`;
        const path = join(env.sessionsDir(), `${session}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
        let releaseRead: (records: never[]) => void = () => {};
        const stalledRead = new Promise<never[]>((resolve) => {
            releaseRead = resolve;
        });

        const started = Date.now();
        const result = await waitForSessionRecord(
            { session, waitForExit: true, timeoutMs: 50 },
            { readExisting: () => stalledRead }
        );

        expect(result).toEqual({ reason: "timeout" });
        expect(Date.now() - started).toBeLessThan(2_000);
        releaseRead([]);
    });
});

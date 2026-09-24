import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTaskIntegrationHome, withTaskSession } from "./task-integration-env";

const taskEnv = setupTaskIntegrationHome();

const readSessionFile = (session: string, suffix: string): string =>
    readFileSync(join(taskEnv.sessionsDir(), `${session}${suffix}`), "utf-8");

const countLines = (text: string, needle: string): number => text.split("\n").filter((line) => line === needle).length;

test("the detached worker does not mirror captured output into the session log a second time", async () => {
    const session = `dupe-${Date.now()}`;

    await withTaskSession(taskEnv, session, async () => {
        taskEnv.task(["run", "--session", session, "--no-tty", "--", "printf", "MARKER\\nMARKER\\n"]);

        expect(countLines(readSessionFile(session, ".log"), "MARKER")).toBe(2);
    });
}, 30_000);

test("the worker's own banner stays out of the session log", async () => {
    const session = `dupe-banner-${Date.now()}`;

    await withTaskSession(taskEnv, session, async () => {
        taskEnv.task(["run", "--session", session, "--no-tty", "--", "printf", "ONLY_ME\\n"]);

        const log = readSessionFile(session, ".log");

        expect(log.trim()).toBe("ONLY_ME");
        expect(log).not.toContain("task session:");
    });
}, 30_000);

test("the worker log keeps the banner, so a crash before capture starts is still diagnosable", async () => {
    const session = `dupe-worker-${Date.now()}`;

    await withTaskSession(taskEnv, session, async () => {
        taskEnv.task(["run", "--session", session, "--no-tty", "--", "printf", "ANY\\n"]);

        expect(readSessionFile(session, ".worker.log")).toContain("task session:");
    });
}, 30_000);

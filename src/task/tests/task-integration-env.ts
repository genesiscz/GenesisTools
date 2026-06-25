import { afterAll } from "bun:test";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "@app/utils/env";

const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

export interface TaskRunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface TaskIntegrationEnv {
    homeDir: string;
    task: (args: string[], opts?: { timeout?: number }) => TaskRunResult;
    taskSpawn: (args: string[], opts?: SpawnOptions) => ReturnType<typeof spawn>;
    sessionsDir: () => string;
    clean: (session: string) => void;
}

export function setupTaskIntegrationHome(): TaskIntegrationEnv {
    const homeDir = mkdtempSync(join(tmpdir(), "gt-task-int-"));
    const childEnv = { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: homeDir };

    afterAll(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    const clean = (session: string) => {
        spawnSync("bun", [TASK_TOOL, "task", "clean", "--session", session], {
            env: childEnv,
            stdio: "ignore",
        });
    };

    return {
        homeDir,
        task(args, opts) {
            const r = spawnSync("bun", [TASK_TOOL, "task", ...args], {
                encoding: "utf-8",
                env: childEnv,
                timeout: opts?.timeout,
            });

            return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        },
        taskSpawn(args, opts) {
            return spawn("bun", [TASK_TOOL, "task", ...args], {
                ...opts,
                env: { ...childEnv, ...opts?.env },
            });
        },
        sessionsDir: () => join(homeDir, ".genesis-tools", "task", "sessions"),
        clean,
    };
}

export async function withTaskSession(
    env: TaskIntegrationEnv,
    session: string,
    fn: () => void | Promise<void>
): Promise<void> {
    env.clean(session);

    try {
        await fn();
    } finally {
        env.clean(session);
    }
}

/**
 * Wait until a detached `tools task` session is observable on disk, instead of a
 * fixed sleep. Polls the session artifacts under env.sessionsDir() (the test's
 * temp home): returns as soon as the session exists — faster than a fixed warm-up
 * when uncontended, and correct under parallel-test subprocess contention, where
 * a fixed sleep races the detached session's startup and a foreground wait/tail
 * would otherwise find no session and exit 1.
 */
export async function waitForSession(env: TaskIntegrationEnv, session: string, timeoutMs = 10_000): Promise<void> {
    const jsonl = join(env.sessionsDir(), `${session}.jsonl`);
    const meta = join(env.sessionsDir(), `${session}.meta.json`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (existsSync(jsonl) || existsSync(meta)) {
            return;
        }

        await Bun.sleep(25);
    }

    throw new Error(`task session "${session}" not ready within ${timeoutMs}ms`);
}

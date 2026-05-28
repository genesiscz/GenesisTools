import { afterAll } from "bun:test";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    const childEnv = { ...process.env, GENESIS_TOOLS_HOME: homeDir };

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

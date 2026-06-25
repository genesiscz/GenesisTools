import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@app/utils/env";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface RunTaskCaptureOptions {
    session: string;
    noTty?: boolean;
    tty?: boolean;
    command: string[];
    homeDir?: string;
}

export async function runTaskCapture(opts: RunTaskCaptureOptions): Promise<number> {
    const modeFlags = opts.tty ? ["--tty"] : opts.noTty ? ["--no-tty"] : [];
    const result = await runTaskCli(["run", "--session", opts.session, ...modeFlags, "--", ...opts.command], {
        homeDir: opts.homeDir ?? join(REPO_ROOT, ".tmp-task-test"),
    });
    return result.exitCode;
}

export interface RunTaskCliResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export async function runTaskCli(args: string[], opts: { homeDir: string }): Promise<RunTaskCliResult> {
    const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "src/task/index.ts"), ...args], {
        cwd: REPO_ROOT,
        env: {
            ...env.getProcessEnv(),
            GENESIS_TOOLS_HOME: opts.homeDir,
        },
        stdout: "pipe",
        stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    return { exitCode, stdout, stderr };
}

export async function readTaskJsonl(session: string, homeDir: string) {
    const path = join(homeDir, ".genesis-tools", "task", "sessions", `${session}.jsonl`);
    const records = await readJsonlFile(path);
    return filterLineRecords(records);
}

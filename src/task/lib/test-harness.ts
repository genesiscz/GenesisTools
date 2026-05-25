import { join } from "node:path";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { TASK_SESSIONS_DIR } from "../lib/paths";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export interface RunTaskCaptureOptions {
    session: string;
    noTty?: boolean;
    command: string[];
    homeDir?: string;
}

export async function runTaskCapture(opts: RunTaskCaptureOptions): Promise<number> {
    const homeDir = opts.homeDir ?? join(REPO_ROOT, ".tmp-task-test");
    const proc = Bun.spawn(
        [
            "bun",
            "run",
            join(REPO_ROOT, "src/task/index.ts"),
            "run",
            "--session",
            opts.session,
            ...(opts.noTty ? ["--no-tty"] : []),
            "--",
            ...opts.command,
        ],
        {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                GENESIS_TOOLS_HOME: homeDir,
            },
            stdout: "pipe",
            stderr: "pipe",
        }
    );

    return proc.exited;
}

export async function readTaskJsonl(session: string, homeDir: string) {
    const path = join(homeDir, ".genesis-tools", "task", "sessions", `${session}.jsonl`);
    const records = await readJsonlFile(path);
    return filterLineRecords(records);
}

export { TASK_SESSIONS_DIR };

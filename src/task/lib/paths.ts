import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const ROOT = process.env.GENESIS_TOOLS_HOME || homedir();

export const TASK_SESSIONS_DIR = resolve(ROOT, ".genesis-tools", "task", "sessions");

function safeSessionPath(session: string, suffix: string): string {
    const candidate = resolve(TASK_SESSIONS_DIR, `${session}${suffix}`);
    if (!candidate.startsWith(`${TASK_SESSIONS_DIR}${sep}`)) {
        throw new Error(`Invalid session name: ${session}`);
    }

    return candidate;
}

export function uiJsonlPath(session: string): string {
    return safeSessionPath(session, ".ui.jsonl");
}

export function jsonlPath(session: string): string {
    return safeSessionPath(session, ".jsonl");
}

export function stdoutLogPath(session: string): string {
    return safeSessionPath(session, ".log");
}

export function stderrLogPath(session: string): string {
    return safeSessionPath(session, ".err.log");
}

export function metaPath(session: string): string {
    return safeSessionPath(session, ".meta.json");
}

export function sessionFilePaths(session: string): {
    jsonl: string;
    uiJsonl: string;
    stdout: string;
    stderr: string;
    meta: string;
} {
    return {
        jsonl: jsonlPath(session),
        uiJsonl: uiJsonlPath(session),
        stdout: stdoutLogPath(session),
        stderr: stderrLogPath(session),
        meta: metaPath(session),
    };
}

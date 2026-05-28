import { homedir } from "node:os";
import { resolve, sep } from "node:path";

function genesisToolsRoot(): string {
    return process.env.GENESIS_TOOLS_HOME || homedir();
}

export function getTaskSessionsDir(): string {
    return resolve(genesisToolsRoot(), ".genesis-tools", "task", "sessions");
}

export function taskConfigPath(): string {
    return process.env.TASK_CONFIG_PATH ?? resolve(genesisToolsRoot(), ".genesis-tools", "task", "config.json");
}

function safeSessionPath(session: string, suffix: string): string {
    const sessionsDir = getTaskSessionsDir();
    const candidate = resolve(sessionsDir, `${session}${suffix}`);
    if (!candidate.startsWith(`${sessionsDir}${sep}`)) {
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

export function isCanonicalSessionJsonlFilename(filename: string): boolean {
    return filename.endsWith(".jsonl") && !filename.endsWith(".ui.jsonl");
}

export function sessionNameFromJsonlFilename(filename: string): string | null {
    if (!isCanonicalSessionJsonlFilename(filename)) {
        return null;
    }

    return filename.slice(0, -".jsonl".length);
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

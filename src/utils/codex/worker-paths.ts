import { join } from "node:path";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { safeNamedPath } from "@genesiscz/utils/worker/safe-path";
export function codexRoot(): string {
    return genesisToolsDir("codex");
}

export function sessionsDir(): string {
    return join(codexRoot(), "sessions");
}

function safeSessionPath(name: string, suffix: string): string {
    return safeNamedPath({ root: sessionsDir(), name, suffix, label: "session name" });
}

export function sessionMetaPath(name: string): string {
    return safeSessionPath(name, ".meta.json");
}

export function sessionEventsPath(name: string): string {
    return safeSessionPath(name, ".jsonl");
}

export function sessionDaemonLogPath(name: string): string {
    return safeSessionPath(name, ".daemon.log");
}

export function sessionControlPath(name: string): string {
    return safeSessionPath(name, ".control.jsonl");
}

export function sessionLaunchPath(name: string): string {
    return safeSessionPath(name, ".launch.json");
}

export function sessionResponsePath(name: string, requestId: string): string {
    return safeSessionPath(name, `.response.${requestId}.json`);
}

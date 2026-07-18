import { join, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";

export function codexRoot(): string {
    return join(env.tools.getHome(), ".genesis-tools", "codex");
}

export function sessionsDir(): string {
    return join(codexRoot(), "sessions");
}

function safeSessionPath(name: string, suffix: string): string {
    const root = sessionsDir();
    const candidate = resolve(root, `${name}${suffix}`);
    const validName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
    if (!validName || !candidate.startsWith(`${root}${sep}`)) {
        throw new Error(`Invalid session name: ${name}`);
    }

    return candidate;
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

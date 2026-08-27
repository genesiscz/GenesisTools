import { join, resolve, sep } from "node:path";
import { env } from "@genesiscz/utils/env";

export function grokRoot(): string {
    return join(env.tools.getHome(), ".genesis-tools", "grok");
}

export function sessionsDir(): string {
    return join(grokRoot(), "sessions");
}

export function defaultWorkerHome(): string {
    return join(grokRoot(), "worker-home");
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

export function turnLogPath(name: string, turn: number): string {
    return safeSessionPath(name, `.turn${turn}.jsonl`);
}

export function turnErrPath(name: string, turn: number): string {
    return safeSessionPath(name, `.turn${turn}.err`);
}

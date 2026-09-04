import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { safeNamedPath } from "@genesiscz/utils/worker/safe-path";

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
    return safeNamedPath({ root: sessionsDir(), name, suffix, label: "session name" });
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

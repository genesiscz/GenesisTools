import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { safeNamedPath } from "@genesiscz/utils/worker/safe-path";

export function workersDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "claude", "workers");
}

function safeWorkerPath(name: string, suffix: string): string {
    return safeNamedPath({ root: workersDir(), name, suffix, label: "worker name" });
}

export function workerMetaPath(name: string): string {
    return safeWorkerPath(name, ".meta.json");
}

export function workerTurnLogPath(name: string, turn: number): string {
    return safeWorkerPath(name, `.turn${turn}.jsonl`);
}

export function workerTurnErrPath(name: string, turn: number): string {
    return safeWorkerPath(name, `.turn${turn}.err`);
}

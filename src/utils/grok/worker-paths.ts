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

/**
 * The shared home a session without `--worker-home` runs in. Two of them, one
 * per skills policy, because the `~/.agents` skills tier is switched off in the
 * home's config.toml and a home shared by sessions with opposite choices would
 * rewrite that file under each other (PR #364 review). Both match the
 * `worker-home*` glob the usage scanners walk.
 */
export function defaultWorkerHomeFor(skills: boolean): string {
    return skills ? defaultWorkerHome() : join(grokRoot(), "worker-home-noskills");
}

/** The fixed skills policy of a managed home, or null for a caller-chosen `--worker-home`. */
export function managedHomeSkillsPolicy(workerHome: string): boolean | null {
    if (workerHome === defaultWorkerHomeFor(true)) {
        return true;
    }

    if (workerHome === defaultWorkerHomeFor(false)) {
        return false;
    }

    return null;
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

import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * A host app's capability probe: T3 Code starts claude with `--no-session-persistence` and no session flag every few
 * minutes to read its models and commands. It sends no turn, so it needs no usage ranking (45 of 60 launches on
 * 2026-11-01 were probes, each with a full usage poll).
 */
export function isHostProbe(passthrough: readonly string[]): boolean {
    const names = passthrough.map((arg) => arg.split("=")[0]);

    return (
        names.includes("--no-session-persistence") &&
        !names.some((name) => ["--resume", "-r", "--continue", "-c", "--session-id"].includes(name))
    );
}

function lastPickPath(): string {
    return toolDataDir("claude", "embed-last-pick.json");
}

/** The account the last real embed launch picked, when it is still one of `names`. */
export function readEmbedLastPick(names: readonly string[], path = lastPickPath()): string | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const stored: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        const account =
            typeof stored === "object" && stored !== null && "account" in stored && typeof stored.account === "string"
                ? stored.account
                : null;

        return account && names.includes(account) ? account : null;
    } catch (error) {
        logger.debug({ error, path }, "[embed] last pick unreadable");
        return null;
    }
}

/**
 * Saves the pick for the next host probe. Atomic, and it makes the folder: a probe reads this file while the next
 * launch may be writing it, and a half-written file read as no pick, so the probe ran the full usage ranking again.
 */
export function writeEmbedLastPick(account: string, path = lastPickPath()): void {
    try {
        atomicWriteFileSync(path, SafeJSON.stringify({ account, at: new Date().toISOString() }, { strict: true }));
    } catch (error) {
        logger.debug({ error, path }, "[embed] last pick not saved");
    }
}

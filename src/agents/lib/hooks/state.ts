import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { agentsDataDir } from "./config";
import { hookDiag } from "./log";

export function hooksStateDir(): string {
    return join(agentsDataDir(), "hooks-state");
}

/** A session id that is safe to use as a file name, or null. */
export function safeSessionId(value: unknown): string | null {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

/**
 * Per-session count of context notes already shown per rule, so a long session that leans
 * on `2>/dev/null | head` is told a few times, not a few hundred.
 */
export function readContextCounts(sessionId: string): Record<string, number> {
    try {
        const parsed = SafeJSON.parse(readFileSync(join(hooksStateDir(), `${sessionId}.json`), "utf8"));

        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
    } catch (err) {
        // A missing file is the NORMAL first call of a session, so it is not a diagnostic:
        // logging it put 206 "caught" lines into a 20-minute soak. Only a file that exists
        // and cannot be read is worth a line.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            hookDiag("Context counts exist but could not be read", { err, sessionId });
        }

        return {};
    }
}

export function bumpContextCounts(sessionId: string, ruleIds: string[]): void {
    const counts = readContextCounts(sessionId);

    for (const id of ruleIds) {
        counts[id] = (counts[id] ?? 0) + 1;
    }

    try {
        mkdirSync(hooksStateDir(), { recursive: true });
        writeFileSync(join(hooksStateDir(), `${sessionId}.json`), SafeJSON.stringify(counts));
    } catch (err) {
        // A counter that cannot be written only costs a repeated note.
        hookDiag("Could not persist the context counts", { err, sessionId });
    }
}

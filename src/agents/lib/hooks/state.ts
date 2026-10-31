import { join } from "node:path";
import { safeSessionId as sharedSafeSessionId } from "@genesiscz/utils/agents/session-id";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { type JsonDocument, jsonDocument } from "@genesiscz/utils/storage/locked-document";
import { agentsDataDir } from "./config";
import { hookDiag } from "./log";

/** A counter that waits longer than this for another hook of the same session is skipped: it only costs a note. */
const STATE_LOCK_TIMEOUT_MS = 2000;

export function hooksStateDir(): string {
    return join(agentsDataDir(), "hooks-state");
}

/** A session id that is safe to use as a file name, or null. */
export function safeSessionId(value: unknown): string | null {
    return sharedSafeSessionId(value);
}

/**
 * The per-session numbers the hooks keep (`<hooks-state>/<session>.json`): context-note counts per rule, the Stop
 * hook's loop-guard counter, the nudge turn, chat offsets. Written atomically under a lock, so a hook killed mid-write
 * cannot leave a torn file that reads as `{}` (which reset the loop guard's budget), and two hooks of one session
 * running at once cannot lose each other's count. A file that does not parse is copied aside and starts over.
 */
function stateDocument(sessionId: string): JsonDocument<Record<string, number>> {
    return jsonDocument<Record<string, number>>({
        path: join(hooksStateDir(), `${sessionId}.json`),
        lockTimeoutMs: STATE_LOCK_TIMEOUT_MS,
        empty: () => ({}),
        decode: (raw) => {
            if (!isJsonObject(raw)) {
                throw new Error("hook state is not a JSON object");
            }

            return Object.fromEntries(
                Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number")
            );
        },
        onUnreadable: "preserve",
        writes: "always",
    });
}

/**
 * Per-session count of context notes already shown per rule, so a long session that leans
 * on `2>/dev/null | head` is told a few times, not a few hundred.
 */
export function readContextCounts(sessionId: string): Record<string, number> {
    try {
        // A missing file is the NORMAL first call of a session and reads as `{}` with no diagnostic: logging
        // it put 206 "caught" lines into a 20-minute soak. Only a file that exists and cannot be read is worth a line.
        return stateDocument(sessionId).read();
    } catch (err) {
        hookDiag("Context counts exist but could not be read", { err, sessionId });
        return {};
    }
}

/** Change the session's numbers in one locked read-change-write. */
export async function updateContextCounts(
    sessionId: string,
    change: (counts: Record<string, number>) => Record<string, number>
): Promise<void> {
    try {
        await stateDocument(sessionId).update((counts) => ({ write: change(counts), result: undefined }));
    } catch (err) {
        // A counter that cannot be written only costs a repeated note.
        hookDiag("Could not persist the context counts", { err, sessionId });
    }
}

export function bumpContextCounts(sessionId: string, ruleIds: string[]): Promise<void> {
    return updateContextCounts(sessionId, (counts) => {
        for (const id of ruleIds) {
            counts[id] = (counts[id] ?? 0) + 1;
        }

        return counts;
    });
}

/** Sets numbers in the same per-session file that are not counts, such as the start of the turn a check spoke in. */
export function setContextValues(sessionId: string, values: Record<string, number>): Promise<void> {
    return updateContextCounts(sessionId, (counts) => ({ ...counts, ...values }));
}

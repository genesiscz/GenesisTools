import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeSessionId as sharedSafeSessionId } from "@genesiscz/utils/agents/session-id";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import type { JsonDocument } from "@genesiscz/utils/storage/locked-document";
import { agentsDataDir } from "./config";
import { hookDiag } from "./log";

/** A counter that waits longer than this for another hook of the same session is skipped: it only costs a note. */
const STATE_LOCK_TIMEOUT_MS = 2000;
const STATE_VERSION = 2;

export function hooksStateDir(): string {
    return join(agentsDataDir(), "hooks-state");
}

/** A session id that is safe to use as a file name, or null. */
export function safeSessionId(value: unknown): string | null {
    return sharedSafeSessionId(value);
}

/** The guard's part: how many times each rule's context note was shown in the session. */
export interface GuardSessionState {
    contextNotes: Record<string, number>;
}

/** The decision hooks' part: the loop guard, the question nudge and the chat-answer step. */
export interface DecisionSessionState {
    /** Blocks the `❓ DECISION N` check spent, against `maxBlocksPerSession`. */
    stopBlocks: number;
    nudge: {
        /** The nudge's own blocks, so it and the `❓ DECISION N` check do not spend each other's budget. */
        blocks: number;
        /** The provider's stable key for the last turn the nudge spoke in. */
        lastTurn?: number;
    };
    chat: {
        /** When the chat-answer step last read the session to its end (epoch ms). */
        checkedAt?: number;
        /**
         * Per transcript (a hash of its path), the byte offset the step last read up to. The next read starts there,
         * so each row is read once, however far the oldest open ask is: a time bound with an 8 MB cap never reached
         * answers 229 MB back in a 447 MB transcript and read the same 8 MB on every Stop (2026-10-27).
         */
        offsets: Record<string, number>;
        /** Decisions the step already sent the agent back about. */
        sentBack: string[];
    };
}

/** `<hooks-state>/<session>.json`, one part per hook feature. */
export interface HookSessionState {
    version: typeof STATE_VERSION;
    guard: GuardSessionState;
    decisions: DecisionSessionState;
}

export function emptyHookState(): HookSessionState {
    return {
        version: STATE_VERSION,
        guard: { contextNotes: {} },
        decisions: { stopBlocks: 0, nudge: { blocks: 0 }, chat: { offsets: {}, sentBack: [] } },
    };
}

/** The keys of the version 1 file, a flat bag of numbers that every feature shared. */
const V1_STOP_BLOCK = "decisions-stop-block";
const V1_NUDGE_BLOCK = "decisions-nudge-block";
const V1_NUDGE_TURN = "decisions-nudge-turn";
const V1_CHAT_CHECKED = "decisions-chat-checked";
const V1_CHAT_OFFSET = "decisions-chat-offset:";
const V1_CHAT_SENT_BACK = "decisions-chat-sent-back:";

function numbersOf(value: unknown): Record<string, number> {
    if (!isJsonObject(value)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    );
}

function numberOr(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

/**
 * Version 1 (no `version` key) to version 2: the `decisions-*` keys move into `decisions`, every other number is a
 * guard context-note count. Pure; a version 2 value comes back normalized, so a second run changes nothing.
 */
export function migrateHookState(raw: unknown): HookSessionState {
    const state = emptyHookState();

    if (!isJsonObject(raw)) {
        return state;
    }

    if (raw.version === STATE_VERSION) {
        const guard = isJsonObject(raw.guard) ? raw.guard : {};
        const decisions = isJsonObject(raw.decisions) ? raw.decisions : {};
        const nudge = isJsonObject(decisions.nudge) ? decisions.nudge : {};
        const chat = isJsonObject(decisions.chat) ? decisions.chat : {};
        const lastTurn = numberOr(nudge.lastTurn);
        const checkedAt = numberOr(chat.checkedAt);
        state.guard.contextNotes = numbersOf(guard.contextNotes);
        state.decisions.stopBlocks = numberOr(decisions.stopBlocks) ?? 0;
        state.decisions.nudge = {
            blocks: numberOr(nudge.blocks) ?? 0,
            ...(lastTurn !== undefined ? { lastTurn } : {}),
        };
        state.decisions.chat = {
            ...(checkedAt !== undefined ? { checkedAt } : {}),
            offsets: numbersOf(chat.offsets),
            sentBack: Array.isArray(chat.sentBack)
                ? chat.sentBack.filter((id): id is string => typeof id === "string")
                : [],
        };
        return state;
    }

    for (const [key, value] of Object.entries(numbersOf(raw))) {
        if (key === V1_STOP_BLOCK) {
            state.decisions.stopBlocks = value;
        } else if (key === V1_NUDGE_BLOCK) {
            state.decisions.nudge.blocks = value;
        } else if (key === V1_NUDGE_TURN) {
            state.decisions.nudge.lastTurn = value;
        } else if (key === V1_CHAT_CHECKED) {
            state.decisions.chat.checkedAt = value;
        } else if (key.startsWith(V1_CHAT_OFFSET)) {
            state.decisions.chat.offsets[key.slice(V1_CHAT_OFFSET.length)] = value;
        } else if (key.startsWith(V1_CHAT_SENT_BACK)) {
            state.decisions.chat.sentBack.push(key.slice(V1_CHAT_SENT_BACK.length));
        } else {
            state.guard.contextNotes[key] = value;
        }
    }

    return state;
}

/**
 * The per-session state the hooks keep. Written atomically under a lock, so a hook killed mid-write cannot leave a
 * torn file that reads as empty (which reset the loop guard's budget), and two hooks of one session running at once
 * cannot lose each other's count. A file that does not parse is copied aside and starts over. A version 1 file is
 * read through {@link migrateHookState} and written back as version 2 by the next update.
 */
function statePath(sessionId: string): string {
    return join(hooksStateDir(), `${sessionId}.json`);
}

/** Loaded on the first update only: the locked writer pulls in the logger, which the guard's read path must not pay. */
async function stateDocument(sessionId: string): Promise<JsonDocument<HookSessionState>> {
    const { jsonDocument } = await import("@genesiscz/utils/storage/locked-document");
    return jsonDocument<HookSessionState>({
        path: statePath(sessionId),
        lockTimeoutMs: STATE_LOCK_TIMEOUT_MS,
        empty: emptyHookState,
        decode: (raw) => {
            if (!isJsonObject(raw)) {
                throw new Error("hook state is not a JSON object");
            }

            return migrateHookState(raw);
        },
        onUnreadable: "preserve",
        writes: "always",
    });
}

/** The session's state; a missing or unreadable file reads as empty (an unreadable one is worth a diagnostic). */
export function readHookState(sessionId: string): HookSessionState {
    const path = statePath(sessionId);

    // A missing file is the NORMAL first call of a session and reads as empty with no diagnostic: logging
    // it put 206 "caught" lines into a 20-minute soak. Only a file that exists and cannot be read is worth a line.
    if (!existsSync(path)) {
        return emptyHookState();
    }

    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (!isJsonObject(raw)) {
            throw new Error("hook state is not a JSON object");
        }

        return migrateHookState(raw);
    } catch (err) {
        hookDiag("Hook state exists but could not be read", { err, sessionId });
        return emptyHookState();
    }
}

/** Change the session's state in place, in one locked read-change-write. */
export async function updateHookState(sessionId: string, change: (state: HookSessionState) => void): Promise<void> {
    try {
        await (await stateDocument(sessionId)).mutate(change);
    } catch (err) {
        // A counter that cannot be written only costs a repeated note.
        hookDiag("Could not persist the hook state", { err, sessionId });
    }
}

/**
 * Per-session count of context notes already shown per rule, so a long session that leans
 * on `2>/dev/null | head` is told a few times, not a few hundred.
 */
export function readContextCounts(sessionId: string): Record<string, number> {
    return readHookState(sessionId).guard.contextNotes;
}

export function bumpContextCounts(sessionId: string, ruleIds: string[]): Promise<void> {
    return updateHookState(sessionId, (state) => {
        for (const id of ruleIds) {
            state.guard.contextNotes[id] = (state.guard.contextNotes[id] ?? 0) + 1;
        }
    });
}

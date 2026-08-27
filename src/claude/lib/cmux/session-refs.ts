import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * One line of the append-only journal `record-session-cmux.ts` writes on
 * SessionStart / UserPromptSubmit. UUIDs come from the launch env and survive
 * ref renumbering; `paneRef`/`surfaceRef` come from `cmux identify` and are
 * only meaningful while the same cmux instance is running. Later lines win.
 */
export interface SessionCmuxRefs {
    sessionId: string;
    workspaceId: string | null;
    surfaceId: string | null;
    workspaceRef: string | null;
    paneRef: string | null;
    surfaceRef: string | null;
    windowRef: string | null;
    tmuxPane: string | null;
    cwd: string | null;
    at: number;
}

const HOME = env.tools.getHome();

export const CMUX_REFS_PATH = join(HOME, ".genesis-tools", "claude-code", "cmux-refs.jsonl");

/** Entries older than this are treated as gone — the pane is long closed. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Newest recorded cmux location per session, one pass over the journal.
 * Entries older than MAX_AGE_MS are dropped; surface-less entries (plain
 * Terminal/tmux launches) are kept — callers that need a cmux target filter.
 */
export function loadAllSessionCmuxRefs(refsPath: string = CMUX_REFS_PATH): Map<string, SessionCmuxRefs> {
    const refs = new Map<string, SessionCmuxRefs>();

    if (!existsSync(refsPath)) {
        return refs;
    }

    let raw: string;

    try {
        raw = readFileSync(refsPath, "utf8");
    } catch {
        return refs;
    }

    const cutoff = Date.now() - MAX_AGE_MS;

    for (const line of raw.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let entry: SessionCmuxRefs;

        try {
            entry = SafeJSON.parse(line, { jsonl: true }) as SessionCmuxRefs;
        } catch {
            continue;
        }

        if (typeof entry.sessionId !== "string" || (entry.at ?? 0) < cutoff) {
            continue;
        }

        const id = entry.sessionId.toLowerCase();
        const existing = refs.get(id);

        if (!existing || (entry.at ?? 0) >= (existing.at ?? 0)) {
            refs.set(id, entry);
        }
    }

    return refs;
}

/**
 * Latest recorded cmux location for a session. `query` is a full session id or
 * a prefix of at least 8 characters, matching how `focus`/`send` accept ids.
 */
export function lookupSessionCmuxRefs(query: string, refsPath: string = CMUX_REFS_PATH): SessionCmuxRefs | null {
    const needle = query.trim().toLowerCase();

    if (needle.length < 8 || !existsSync(refsPath)) {
        return null;
    }

    let raw: string;

    try {
        raw = readFileSync(refsPath, "utf8");
    } catch {
        return null;
    }

    let latest: SessionCmuxRefs | null = null;

    for (const line of raw.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let entry: SessionCmuxRefs;

        try {
            entry = SafeJSON.parse(line, { jsonl: true }) as SessionCmuxRefs;
        } catch {
            continue;
        }

        if (typeof entry.sessionId !== "string") {
            continue;
        }

        const id = entry.sessionId.toLowerCase();

        if (!id.startsWith(needle) && id !== needle) {
            continue;
        }

        if (!latest || (entry.at ?? 0) >= (latest.at ?? 0)) {
            latest = entry;
        }
    }

    if (!latest || (latest.at ?? 0) < Date.now() - MAX_AGE_MS) {
        return null;
    }

    // A record with no cmux surface (plain Terminal / tmux session) cannot
    // produce a cmux target; callers fall through to the text matcher.
    if (!latest.surfaceId && !latest.surfaceRef) {
        return null;
    }

    return latest;
}

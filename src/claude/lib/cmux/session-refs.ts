import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
/**
 * The journal is append-only and only the NEWEST record per session wins, so
 * older bytes can never change the answer. Reading the whole file grew the cost
 * of every `claude who` / usage listing without changing the result, so the read
 * is capped at the tail and a truncated first line is dropped.
 */
const MAX_JOURNAL_READ_BYTES = 512 * 1024;

function readJournalTail(refsPath: string): string | null {
    if (!existsSync(refsPath)) {
        return null;
    }

    try {
        const size = statSync(refsPath).size;

        if (size <= MAX_JOURNAL_READ_BYTES) {
            return readFileSync(refsPath, "utf8");
        }

        const fd = openSync(refsPath, "r");

        try {
            const buffer = Buffer.alloc(MAX_JOURNAL_READ_BYTES);
            const read = readSync(fd, buffer, 0, MAX_JOURNAL_READ_BYTES, size - MAX_JOURNAL_READ_BYTES);
            const text = buffer.subarray(0, read).toString("utf8");
            // The window almost certainly starts mid-line; that fragment is not
            // valid JSON and would only inflate the parse-failure count.
            const firstBreak = text.indexOf("\n");

            return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
        } finally {
            closeSync(fd);
        }
    } catch {
        return null;
    }
}

/**
 * Newest recorded cmux location per session, one pass over the journal.
 * Entries older than MAX_AGE_MS are dropped; surface-less entries (plain
 * Terminal/tmux launches) are kept — callers that need a cmux target filter.
 */
export function loadAllSessionCmuxRefs(refsPath: string = CMUX_REFS_PATH): Map<string, SessionCmuxRefs> {
    const refs = new Map<string, SessionCmuxRefs>();
    const raw = readJournalTail(refsPath);

    if (raw === null) {
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
 *
 * Built on loadAllSessionCmuxRefs on purpose: the two used to carry their own
 * copy of the file guard, the read, the line loop, the parse, the sessionId
 * check and the newest-wins rule, which is six chances for the two to drift.
 */
export function lookupSessionCmuxRefs(query: string, refsPath: string = CMUX_REFS_PATH): SessionCmuxRefs | null {
    const needle = query.trim().toLowerCase();

    if (needle.length < 8) {
        return null;
    }

    let latest: SessionCmuxRefs | null = null;

    for (const [id, entry] of loadAllSessionCmuxRefs(refsPath)) {
        if (id !== needle && !id.startsWith(needle)) {
            continue;
        }

        if (!latest || (entry.at ?? 0) >= (latest.at ?? 0)) {
            latest = entry;
        }
    }

    // A record with no cmux surface (plain Terminal / tmux session) cannot
    // produce a cmux target; callers fall through to the text matcher.
    if (!latest || (!latest.surfaceId && !latest.surfaceRef)) {
        return null;
    }

    return latest;
}

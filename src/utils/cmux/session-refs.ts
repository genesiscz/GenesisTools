import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { readLinesBackwardSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const log = logger.child({ component: "cmux:session-refs" });

/**
 * One line of the append-only journal `record-session-cmux.ts` writes on
 * SessionStart / UserPromptSubmit. UUIDs come from the launch env and survive
 * ref renumbering; `paneRef`/`surfaceRef` come from `cmux identify` and are
 * only meaningful while the same cmux instance is running. Later lines win.
 */
export interface SessionCmuxRefs {
    sessionId: string;
    /**
     * Which agent wrote this record. Codex and Grok run the same hook, so their records land
     * here too, and `latestRefsBySession` keeps only Claude's.
     *
     * ⚠️ ABSENT does NOT mean Claude. The tag was added after the hook shipped, so every line
     * older than it is untagged whichever agent wrote it, and 29 of those on this machine are
     * Codex rollouts. A consumer that turns an id into a launch command must decide for
     * itself — see `resolveRefsProvider` below, which consults the
     * pin journal first and falls back to the id shape.
     */
    provider?: AccountProviderAlias;
    /** Workspace UUID where the tab was at this record (a moved tab gets the new one at its next prompt). */
    workspaceId: string | null;
    /** Surface UUID: the identity. It survives a cmux relaunch and a move to another workspace. */
    surfaceId: string | null;
    /** Pane and window UUIDs at this record. Absent on records written before 2026-10-14. */
    paneId?: string | null;
    windowId?: string | null;
    /** The refs below are display-only: cmux renumbers them at every relaunch. */
    workspaceRef: string | null;
    paneRef: string | null;
    surfaceRef: string | null;
    windowRef: string | null;
    tmuxPane: string | null;
    cwd: string | null;
    at: number;
    /** The user ended the session on purpose (`/exit`) at `at`; it must not be resumed in this tab. */
    ended?: boolean;
    /**
     * Set by `loadAllSessionCmuxRefs`: the first time the journal saw this session on the surface of its newest
     * line. Which session a launch started first tells the tab's own agent from workers started inside it.
     */
    firstAt?: number;
}

export const CMUX_REFS_PATH = genesisToolsDir("claude-code", "cmux-refs.jsonl");

/**
 * Append one record, in the format the SessionStart / UserPromptSubmit hook writes
 * (`plugins/genesis-tools/hooks/record-session-cmux.ts`). For a writer that KNOWS which
 * session runs in which surface without the hook: a restore that typed the resume
 * itself. The hook only runs where the plugin loaded, and on 2026-10-14 a broken
 * marketplace manifest kept it off in every session started for twelve hours, so the
 * tabs those sessions held were unknown at the next relaunch.
 */
export function appendSessionCmuxRef(
    entry: Omit<SessionCmuxRefs, "at"> & { at?: number },
    refsPath: string = CMUX_REFS_PATH
): void {
    mkdirSync(dirname(refsPath), { recursive: true });
    appendFileSync(refsPath, `${SafeJSON.stringify({ ...entry, at: entry.at ?? Date.now() })}\n`, "utf8");
}

/**
 * Entries older than this are treated as gone — the pane is long closed. The journal itself keeps them; the
 * readers stop reading the file there (`readJournalSince`).
 */
export const CMUX_REFS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Lines are appended in time order (0 of 19,344 out of order on 2026-10-15); this covers a writer's clock skew. */
const JOURNAL_ORDER_SLACK_MS = 60 * 60_000;
/** One stray old line (a hand-edited or restored record) must not hide the newer-but-in-window lines before it. */
const OLD_LINES_BEFORE_STOP = 64;
const AT_FIELD = /"at":(\d+)/;

/**
 * The journal lines written since `sinceMs`, oldest first, read from the END of the file. The journal is kept whole
 * (every line, for history and triage); a reader only needs its last days, and the lines are in time order, so the
 * read stops after a run of lines older than `sinceMs` (with an hour of slack). On 2026-10-15 the 6.9 MB journal held
 * 13,825 lines older than the readers' 7 days. Null when the file is missing or unreadable.
 */
function readJournalSince(
    refsPath: string,
    { sinceMs, onReadError }: { sinceMs: number; onReadError?: (error: unknown) => void }
): string[] | null {
    const lines: string[] = [];
    let oldRun = 0;

    try {
        for (const line of readLinesBackwardSync(refsPath)) {
            const at = Number(AT_FIELD.exec(line)?.[1]);
            oldRun = at < sinceMs - JOURNAL_ORDER_SLACK_MS ? oldRun + 1 : 0;

            if (oldRun >= OLD_LINES_BEFORE_STOP) {
                break;
            }

            lines.push(line);
        }
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }

        log.warn({ err, refsPath }, "cannot read the cmux refs journal");
        onReadError?.(err);
        return null;
    }

    return lines.reverse();
}

/**
 * Newest recorded cmux location per session, one pass over the journal.
 * Entries older than MAX_AGE_MS are dropped; surface-less entries (plain
 * Terminal/tmux launches) are kept — callers that need a cmux target filter.
 * `onReadError` distinguishes an unreadable journal from one that is empty or does not exist.
 */
export function loadAllSessionCmuxRefs(
    refsPath: string = CMUX_REFS_PATH,
    options: { beforeMs?: number; onReadError?: (error: unknown) => void } = {}
): Map<string, SessionCmuxRefs> {
    const refs = new Map<string, SessionCmuxRefs>();
    /** `<session>\n<surface>` → the first time that session was seen on that surface. */
    const firstSeen = new Map<string, number>();
    const cutoff = (options.beforeMs ?? Date.now()) - CMUX_REFS_MAX_AGE_MS;
    const lines = readJournalSince(refsPath, { sinceMs: cutoff, onReadError: options.onReadError });

    if (lines === null) {
        return refs;
    }

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        let entry: SessionCmuxRefs;

        try {
            entry = SafeJSON.parse(line, { jsonl: true }) as SessionCmuxRefs;
        } catch (err) {
            // The parse error and the position are enough to triage. The line
            // itself is not logged: this journal carries session ids and
            // filesystem locations, and a corrupted record can hold arbitrary
            // text from whatever clobbered it (PR #332 review t11).
            log.debug({ err, refsPath, lineLength: line.length }, "skipping malformed cmux refs line");
            continue;
        }

        if (typeof entry.sessionId !== "string" || (entry.at ?? 0) < cutoff) {
            continue;
        }

        if (options.beforeMs !== undefined && entry.at > options.beforeMs) {
            continue;
        }

        const id = entry.sessionId.toLowerCase();
        const existing = refs.get(id);
        const spanKey = `${id}\n${entry.surfaceId?.toLowerCase() ?? ""}`;
        firstSeen.set(spanKey, Math.min(firstSeen.get(spanKey) ?? Number.POSITIVE_INFINITY, entry.at ?? 0));

        if (!existing || (entry.at ?? 0) >= (existing.at ?? 0)) {
            refs.set(id, entry);
        }
    }

    for (const [id, entry] of refs) {
        const first = firstSeen.get(`${id}\n${entry.surfaceId?.toLowerCase() ?? ""}`);
        refs.set(id, { ...entry, ...(first !== undefined ? { firstAt: first } : {}) });
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
    const all = loadAllSessionCmuxRefs(refsPath);

    for (const [id, entry] of all) {
        if (id !== needle && !id.startsWith(needle)) {
            continue;
        }

        if (!latest || (entry.at ?? 0) >= (latest.at ?? 0)) {
            latest = entry;
        }
    }

    // A record with no surface UUID (plain Terminal / tmux session, or a line from before UUIDs) cannot
    // produce a cmux target: its ref is from the cmux run that wrote it. Callers fall through to the matcher.
    if (!latest?.surfaceId || latest.ended) {
        return null;
    }

    // The tab is the session's only while no other session was recorded there later: `focus`/`send` act on the
    // tab's current occupant, and typing into a tab another session took over reaches the wrong agent.
    const surface = latest.surfaceId.toLowerCase();
    const at = latest.at ?? 0;
    const sessionId = latest.sessionId;
    const takenOver = [...all.values()].some(
        (entry) => entry.sessionId !== sessionId && entry.surfaceId?.toLowerCase() === surface && (entry.at ?? 0) > at
    );

    return takenOver ? null : latest;
}

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Which agent PROBABLY wrote a journal record that predates the provider tag.
 *
 * ⚠️ A heuristic, not a proof, and the last resort: the pin journal is consulted first
 * because it names the provider outright. Claude Code writes a UUIDv4 and the other two
 * normally write a UUIDv7, which is what lets the v7 records be dropped instead of typed
 * into `claude --resume`. The converse does NOT hold. A read-only count of the shared
 * history index on 2026-09-14 found 4 Codex and 6 Grok sessions with v4-shaped ids
 * (pre-switchover Codex rollouts from 2025/09, and Grok worktree/subagent sessions), and
 * this rule claims every one of them for Claude. None is in the cmux journal today, and
 * `CMUX_REFS_MAX_AGE_MS` keeps ordinary reads inside the tagged era, but `loadSurfaceSessions({
 * beforeMs })` walks the journal historically and can still reach one.
 *
 * Which of the two v7 agents wrote a record cannot be proven from the id either, so a v7
 * id with no pin is dropped rather than guessed: the pane then falls back to its captured
 * command instead of resuming a session that belongs to another agent.
 */
function untaggedProvider(sessionId: string): AccountProviderAlias | undefined {
    return CLAUDE_SESSION_ID.test(sessionId) ? "claude" : undefined;
}

/**
 * Which agent a journal record belongs to: its own tag, then the session's pin (which names the
 * provider outright), then the id shape. Undefined when none of the three can tell.
 */
export function resolveRefsProvider(
    entry: Pick<SessionCmuxRefs, "sessionId" | "provider">,
    pin: { provider?: AccountProviderAlias } | undefined
): AccountProviderAlias | undefined {
    return entry.provider ?? pin?.provider ?? untaggedProvider(entry.sessionId);
}

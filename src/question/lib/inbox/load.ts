import { statSync } from "node:fs";
import { type AgentSessionRow, listAgentSessionRows } from "@app/ai/lib/sessions/agent-session-rows";
import { transcriptEnvelope } from "@genesiscz/utils/ai/transcripts/load";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { decisionFiles } from "../decisions/read";
import { type DecisionRecord, type HarvestedDecision, readDecisions } from "../decisions/store";
import { listPendingForms } from "../pending/ask";
import type { AskForm } from "../pending/types";
import {
    buildInbox,
    type InboxDecision,
    type InboxSession,
    scanTurns,
    sessionDecisions,
    type TranscriptScan,
} from "./build";
import { fillExcerpts } from "./excerpts";

const { log } = logger.scoped("question-inbox");

/** The last few turns are enough: the question is the agent's final reply, or nothing is waiting. */
const TAIL_TURNS = 6;
// v2: the parser now keeps each block's context, per-option rationale and recommended letter, so a
// scan cached by the old parser (header and options only) must be discarded, not reused.
const CACHE_KEY = "inbox/scans-v2.json";

/** One scanned file, reused while its size and mtime are unchanged. */
interface CachedScan {
    size: number;
    mtimeMs: number;
    scan: TranscriptScan | null;
}

type ScanCache = Record<string, CachedScan>;

export interface InboxDeps {
    sessions: (hours: number) => Promise<AgentSessionRow[]>;
    tail: (row: AgentSessionRow) => Promise<TranscriptTurn[]>;
    stat: (path: string) => { size: number; mtimeMs: number } | null;
    rows: () => DecisionRecord[];
    forms: () => AskForm[];
    readCache: () => Promise<ScanCache | null>;
    writeCache: (cache: ScanCache) => Promise<void>;
}

function storage(): Storage {
    return new Storage("question");
}

export const realInboxDeps: InboxDeps = {
    sessions: (hours) => listAgentSessionRows({ hours }),
    tail: async (row) => {
        const resolved: ResolvedTranscript = {
            provider: row.provider,
            source: "native",
            sessionId: row.sessionId,
            filePath: row.filePath,
        };
        return (await transcriptEnvelope(resolved, { limit: TAIL_TURNS })).turns;
    },
    stat: (path) => {
        try {
            const info = statSync(path);
            return { size: info.size, mtimeMs: info.mtimeMs };
        } catch (error) {
            log.debug({ error, path }, "inbox: session file is gone");
            return null;
        }
    },
    rows: () => readDecisions(decisionFiles().file),
    forms: () => listPendingForms({}, 200),
    readCache: () => storage().getCacheFile<ScanCache>(CACHE_KEY, "7 days"),
    writeCache: (cache) => storage().putCacheFile(CACHE_KEY, cache, "7 days"),
};

/** What the session's last reply asks, read fresh from its transcript. */
async function scanSession(session: string): Promise<TranscriptScan | null> {
    const resolved = await resolveTranscript(session);
    return scanTurns((await transcriptEnvelope(resolved, { limit: TAIL_TURNS })).turns);
}

/**
 * The `❓ DECISION N` block the session's last reply still waits on. Null when the reply asks no
 * such number, and also when the session has no transcript to read (a posted-only session, an
 * invented id): the caller then refuses with "DECISION N is not waiting", not a resolver error.
 */
export async function waitingBlock(
    session: string,
    number: number,
    scan: typeof scanSession = scanSession
): Promise<HarvestedDecision | null> {
    let found: TranscriptScan | null;

    try {
        found = await scan(session);
    } catch (error) {
        log.debug({ error, session, number }, "waiting block: the session's transcript cannot be read");
        return null;
    }

    return found?.blocks.find((block) => block.number === number) ?? null;
}

/** Every decision of one session (the hub's Decisions pane). A transcript that cannot be read leaves the stored rows. */
export async function loadSessionDecisions(
    session: string,
    { rows = realInboxDeps.rows, scan = scanSession }: { rows?: () => DecisionRecord[]; scan?: typeof scanSession } = {}
): Promise<InboxDecision[]> {
    let found: TranscriptScan | null = null;

    try {
        found = await scan(session);
    } catch (error) {
        log.debug({ error, session }, "session decisions: transcript not readable, stored rows only");
    }

    const cwd = rows().find((row) => row.sessionId === session)?.cwd;
    return withExcerpts(sessionDecisions({ sessionId: session, rows: rows(), scan: found }), cwd);
}

/** Reads each decision's `file:line` references from disk (bounded), off the hub's hot path. */
function withExcerpts(decisions: InboxDecision[], cwd: string | undefined): InboxDecision[] {
    return decisions.map((item) => ({ ...item, refs: fillExcerpts(item.refs, cwd) }));
}

export interface InboxResult {
    sessions: InboxSession[];
    scanned: { sessions: number; fromCache: number; read: number; failed: number };
    elapsedMs: number;
}

/**
 * Reads every source and builds the inbox. A transcript is re-read only when its file changed
 * since the last scan (size and mtime), so a refresh of an unchanged list reads no transcript.
 */
export async function loadInbox({
    hours = 72,
    deps = realInboxDeps,
}: {
    hours?: number;
    deps?: InboxDeps;
} = {}): Promise<InboxResult> {
    const started = performance.now();
    const sessions = (await deps.sessions(hours)).filter((row) => !row.archived && row.filePath);
    const previous = (await deps.readCache()) ?? {};
    const next: ScanCache = {};
    const scans = new Map<string, TranscriptScan>();
    const scanned = { sessions: sessions.length, fromCache: 0, read: 0, failed: 0 };

    await concurrentMap({
        items: sessions,
        concurrency: 6,
        fn: async (row) => {
            const stat = deps.stat(row.filePath);

            if (!stat) {
                return;
            }

            const cached = previous[row.filePath];
            let scan: TranscriptScan | null;

            if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
                scan = cached.scan;
                scanned.fromCache++;
            } else {
                scan = scanTurns(await deps.tail(row));
                scanned.read++;
            }

            next[row.filePath] = { size: stat.size, mtimeMs: stat.mtimeMs, scan };

            if (scan) {
                scans.set(row.sessionId, scan);
            }
        },
        onError: (row, error) => {
            scanned.failed++;
            log.warn({ error, session: row.sessionId, provider: row.provider }, "inbox: could not read a transcript");
        },
    });

    await deps.writeCache(next);
    const inbox = buildInbox({ sessions, scans, rows: deps.rows(), forms: deps.forms() }).map((session) => ({
        ...session,
        items: session.items.map((item) =>
            item.kind === "decision" ? { ...item, refs: fillExcerpts(item.refs, session.cwd ?? undefined) } : item
        ),
    }));
    const elapsedMs = Math.round(performance.now() - started);
    log.debug({ hours, ...scanned, waiting: inbox.length, elapsedMs }, "inbox loaded");

    return { sessions: inbox, scanned, elapsedMs };
}

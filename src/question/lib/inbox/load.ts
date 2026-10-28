import { statSync } from "node:fs";
import { dirname } from "node:path";
import { loadHooksConfig } from "@app/agents/lib/hooks/config";
import type { AgentSessionRow, AgentSessionRowsOptions } from "@app/ai/lib/sessions/agent-session-rows";
import { POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/listing-reuse";
import { readCachedSessionCwd } from "@genesiscz/utils/agent-sessions/cached-title";
import { transcriptEnvelope } from "@genesiscz/utils/ai/transcripts/load";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { decisionFiles } from "../decisions/read";
import {
    type DecisionRecord,
    type DecisionState,
    type HarvestedDecision,
    harvestDecisions,
    kindOf,
    readDecisions,
} from "../decisions/store";
import { listFormsSnapshot } from "../pending/store";
import type { AskForm } from "../pending/types";
import { type QaRow, queryEntriesSnapshot } from "../read-model";
import {
    buildInbox,
    type InboxDecision,
    type InboxForm,
    type InboxSession,
    inboxForm,
    scanTurns,
    sessionDecisions,
    type TranscriptScan,
} from "./build";
import { fillExcerpts, tracedReadDeps } from "./excerpts";
import type { InboxTrace } from "./session-cursor";
import { stagedSendText } from "./staged";

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
    /**
     * Stores a listed session's unposted blocks as open decisions (`decisions.harvestListed`); answers how many it
     * stored. Absent: the inbox only lists them.
     */
    harvest?: (input: {
        sessionId: string;
        provider?: string;
        cwd?: string;
        found: HarvestedDecision[];
        at: string | null;
    }) => Promise<number>;
    forms: () => AskForm[] | Promise<AskForm[]>;
    readCache: () => Promise<ScanCache | null>;
    writeCache: (cache: ScanCache) => Promise<void>;
}

function storage(): Storage {
    return new Storage("question");
}

export const realInboxDeps: InboxDeps = {
    sessions: async (hours) =>
        (await import("@app/ai/lib/sessions/agent-session-rows")).listAgentSessionRows({
            hours,
            withUsage: false,
            maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
        }),
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
    harvest: async ({ sessionId, provider, cwd, found, at }) => {
        if (!loadHooksConfig().decisions.harvestListed) {
            return 0;
        }

        const { file, events } = decisionFiles();
        // Asked when the reply was written, not when the inbox first listed it: the waiting count's freshness and
        // the chat-answer step read the ask time.
        const stored = await harvestDecisions(
            file,
            events,
            { sessionId, ...(provider ? { provider } : {}), ...(cwd ? { cwd } : {}), found },
            () => at ?? new Date().toISOString()
        );
        return stored.length;
    },
    forms: async () => (await import("../pending/ask")).listPendingForms({}, 200),
    readCache: () => storage().getCacheFile<ScanCache>(CACHE_KEY, "7 days"),
    writeCache: (cache) => storage().putCacheFile(CACHE_KEY, cache, "7 days"),
};

/**
 * The listed sessions' unposted `❓ DECISION N` blocks, stored as open decisions (`InboxDeps.harvest`), so the widget,
 * which reads only the decision log, counts and answers the same decisions as the hub. A block the log has under its
 * number in any state is left alone.
 */
async function harvestListed({
    sessions,
    scans,
    rows,
    deps,
}: {
    sessions: AgentSessionRow[];
    scans: Map<string, TranscriptScan>;
    rows: readonly DecisionRecord[];
    deps: InboxDeps;
}): Promise<number> {
    if (!deps.harvest) {
        return 0;
    }

    const known = new Set(
        rows.filter((row) => kindOf(row) === "decision").map((row) => `${row.sessionId}#${row.number}`)
    );
    let stored = 0;

    for (const [sessionId, scan] of scans) {
        const found = scan.blocks.filter((block) => !known.has(`${sessionId}#${block.number}`));

        if (found.length === 0) {
            continue;
        }

        const session = sessions.find((row) => row.sessionId === sessionId);

        try {
            stored += await deps.harvest({
                sessionId,
                ...(session?.provider ? { provider: session.provider } : {}),
                ...(session?.cwd ? { cwd: session.cwd } : {}),
                found,
                at: scan.at,
            });
        } catch (error) {
            log.warn({ error, session: sessionId }, "inbox: could not store the unposted decisions it lists");
        }
    }

    if (stored > 0) {
        log.info({ stored }, "inbox: stored unposted decisions it lists");
    }

    return stored;
}

/** Where a session's transcript is when the caller knows it, and what a cursor records of the read. */
export interface ScanOptions {
    /** The transcript file; skips the lookup by id, a walk of every project folder (about 30 ms). */
    transcript?: { path: string; provider: ResolvedTranscript["provider"] };
    trace?: InboxTrace;
}

/**
 * Probes every file a transcript read consumes. A worker's transcript is its newest turn file plus the earlier ones,
 * so a cursor must also see an earlier file change and a new turn file appear (a new entry changes its folder's
 * identity); without that, a worker's next reply would leave a `--since` answer "unchanged" for good.
 */
export function traceTranscript(trace: InboxTrace, resolved: ResolvedTranscript): void {
    trace.probe(resolved.filePath);

    for (const extra of resolved.extraFiles ?? []) {
        trace.probe(extra);
    }

    if (resolved.source === "worker") {
        trace.probe(dirname(resolved.filePath));
    }
}

/** What the session's last reply asks, read fresh from its transcript. */
async function scanSession(session: string, { transcript, trace }: ScanOptions = {}): Promise<TranscriptScan | null> {
    const resolved: ResolvedTranscript = transcript
        ? { provider: transcript.provider, source: "native", sessionId: session, filePath: transcript.path }
        : await resolveTranscript(session);
    if (trace) {
        traceTranscript(trace, resolved);
    }

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
        found = await scan(session, {});
    } catch (error) {
        log.debug({ error, session, number }, "waiting block: the session's transcript cannot be read");
        return null;
    }

    return found?.blocks.find((block) => block.number === number) ?? null;
}

/** The listings a folder lookup reads when the index does not know the session: 72 hours, then 90 days. */
const LOOKUP_WINDOWS_HOURS = [72, 24 * 90];

/**
 * One listing of the lookup. Only the first may reuse a poller's refresh from the last seconds: that
 * refresh covered its own window, never a session older than it that was not indexed yet, which is
 * what the 90-day pass is there to find.
 */
export function lookupListing(hours: number): AgentSessionRowsOptions {
    return {
        hours,
        withUsage: false,
        ...(hours === LOOKUP_WINDOWS_HOURS[0] ? { maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS } : {}),
    };
}

/**
 * The folder of a session that has no stored row. The history index answers first: a hub session
 * click used to list every provider's sessions, twice for one older than 72 h (0.7 to 1.2 s), to
 * read one folder the index holds. The refreshed listing stays as the fallback for a session too
 * new to be indexed yet; there the exact id wins in either window, and a prefix counts only when it
 * names one session, never the first of several.
 */
export async function lookupSessionCwd(
    session: string,
    list: (hours: number) => Promise<AgentSessionRow[]> = async (hours) =>
        (await import("@app/ai/lib/sessions/agent-session-rows")).listAgentSessionRows(lookupListing(hours))
): Promise<string | null> {
    const cached = readCachedSessionCwd({ sessionId: session });

    if (cached) {
        return cached;
    }

    let rows: AgentSessionRow[] = [];

    for (const hours of LOOKUP_WINDOWS_HOURS) {
        rows = await list(hours);
        const exact = rows.find((candidate) => candidate.sessionId === session);

        if (exact) {
            return exact.cwd || null;
        }
    }

    const prefixed = rows.filter((candidate) => candidate.sessionId.startsWith(session));

    if (new Set(prefixed.map((candidate) => candidate.sessionId)).size !== 1) {
        return null;
    }

    return prefixed[0].cwd || null;
}

/** Every decision of one session (the hub's Decisions pane). A transcript that cannot be read leaves the stored rows. */
export async function loadSessionDecisions(
    session: string,
    {
        rows = realInboxDeps.rows,
        scan = scanSession,
        sessionCwd = lookupSessionCwd,
        transcript,
        trace,
    }: {
        rows?: () => DecisionRecord[];
        scan?: typeof scanSession;
        sessionCwd?: typeof lookupSessionCwd;
    } & ScanOptions = {}
): Promise<InboxDecision[]> {
    let found: TranscriptScan | null = null;

    try {
        found = await scan(session, { ...(transcript ? { transcript } : {}), ...(trace ? { trace } : {}) });
    } catch (error) {
        log.debug({ error, session }, "session decisions: transcript not readable, stored rows only");
        trace?.cannotProve("the transcript could not be read");
    }

    if (found && found.at === null && found.blocks.length > 0) {
        // A block with no time of its own is stamped with the clock (`sessionDecisions`).
        trace?.cannotProve("a reply block has no time of its own");
    }

    const stored = rows();
    const decisions = sessionDecisions({ sessionId: session, rows: stored, scan: found });

    // A decision harvested from the transcript has no stored row to carry the folder; without it
    // every `file:line` of the Decisions pane read "file not found" while the Inbox showed the lines.
    // The session listing is asked only when a reference needs a folder and no stored row has one.
    const needsFolder = decisions.some((item) => item.refs.length > 0);
    const storedCwd = stored.find((row) => row.sessionId === session && row.cwd)?.cwd;
    const looked = !storedCwd && needsFolder;

    if (looked) {
        trace?.cannotProve("the session folder came from the session listing");
    }

    const cwd = storedCwd || (looked ? await sessionCwd(session) : null) || undefined;
    return withExcerpts(decisions, cwd, trace);
}

/** How many of a session's newest Q→A entries `loadSessionInbox` returns. */
const SESSION_ENTRIES = 40;

/** A todo of one session, as the mods Inbox sidebar lists it. */
export interface SessionTodo {
    id: string;
    number: number;
    title: string;
    state: DecisionState;
    at: string;
}

/** Everything the answer log holds for one session: `inbox --session <id> --all-items`, the mods sidebars' read. */
export interface SessionInbox {
    sessionId: string;
    decisions: InboxDecision[];
    /** The message `inbox send` would submit now (`stagedSendText`); absent when nothing is staged. */
    staged?: string;
    todos: SessionTodo[];
    /** Its newest Q→A entries (messages and recorded answers), oldest first, with `readAt`. */
    entries: QaRow[];
    forms: InboxForm[];
}

/**
 * One session's decisions in every state, its todos, its newest Q→A entries and its pending forms, from one read of
 * the decision log. Reads only: the forms come from a read snapshot filtered in SQL, so no form is expired here.
 */
export async function loadSessionInbox(
    session: string,
    {
        rows = realInboxDeps.rows,
        forms = (id: string) => listFormsSnapshot({ opts: { sessionHint: id, status: "pending" } }),
        entries = (id: string) =>
            queryEntriesSnapshot({
                dbPath: toolDataDir("question", "qa.db"),
                opts: { sessionId: id, limit: SESSION_ENTRIES },
            }),
        transcript,
        trace,
        decisions = (id: string, stored: DecisionRecord[]) =>
            loadSessionDecisions(id, {
                rows: () => stored,
                ...(transcript ? { transcript } : {}),
                ...(trace ? { trace } : {}),
            }),
    }: {
        rows?: () => DecisionRecord[];
        forms?: (session: string) => AskForm[];
        entries?: (session: string) => QaRow[];
        decisions?: (session: string, stored: DecisionRecord[]) => Promise<InboxDecision[]>;
    } & ScanOptions = {}
): Promise<SessionInbox> {
    const stored = rows();

    if (stored.some((row) => row.sessionId === session && (row.promptReservation?.expiresAt ?? 0) > Date.now())) {
        trace?.cannotProve("a prompt reservation can expire without a file change");
    }

    const todos = stored
        .filter((row) => row.sessionId === session && kindOf(row) === "todo")
        .map((row) => ({
            id: row.id,
            number: row.number,
            title: row.title ?? row.prompt.split("\n")[0] ?? "",
            state: row.state,
            at: row.updatedTs,
        }))
        .sort((a, b) => a.number - b.number);
    const waiting = forms(session).map(inboxForm);

    const staged = stagedSendText(stored, session);

    return {
        sessionId: session,
        decisions: await decisions(session, stored),
        ...(staged ? { staged } : {}),
        todos,
        entries: entries(session),
        forms: waiting,
    };
}

/** Reads each decision's `file:line` references from disk (bounded), off the hub's hot path. */
function withExcerpts(decisions: InboxDecision[], cwd: string | undefined, trace?: InboxTrace): InboxDecision[] {
    const deps = trace ? tracedReadDeps(trace) : undefined;
    return decisions.map((item) => ({ ...item, refs: fillExcerpts(item.refs, cwd, deps) }));
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
    const listed = deps.rows();
    const harvested = await harvestListed({ sessions, scans, rows: listed, deps });
    const rows = harvested > 0 ? deps.rows() : listed;
    const inbox = buildInbox({ sessions, scans, rows, forms: await deps.forms() }).map((session) => ({
        ...session,
        items: session.items.map((item) =>
            item.kind === "decision" ? { ...item, refs: fillExcerpts(item.refs, session.cwd ?? undefined) } : item
        ),
    }));
    const elapsedMs = Math.round(performance.now() - started);
    log.debug({ hours, ...scanned, waiting: inbox.length, elapsedMs }, "inbox loaded");

    return { sessions: inbox, scanned, elapsedMs };
}

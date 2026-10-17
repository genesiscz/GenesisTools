import type { AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { type ActiveAgentProcess, listActiveAgentProcesses, runCapture } from "@genesiscz/utils/ai/active-processes";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { loadAllSessionCmuxRefs, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * `tools <agent> who` for every coding agent: live processes, the account each bills, the session each runs, the
 * cmux tab it shows in, and (where the agent's plugin can read it) the session's name and last message.
 *
 * What differs per agent is an {@link AgentWhoSource}, declared beside the agent's own code (its process
 * classifier, how its argv names a resumed session, its transcript reader). Everything else here is shared: the
 * process scan, the cmux join by surface UUID, and the session assignment. A DIAGNOSTIC: it reads the process
 * table, cmux and the transcripts, and writes nothing.
 */

/** A live session's name and transcript clock, as the agent's plugin reads them. */
export interface AgentSessionFacts {
    sessionId: string;
    cwd: string | null;
    title?: string | null;
    /** The transcript, for `tail`. */
    filePath?: string;
    /** Eligible for cwd inference: recent and from a catalog known not to be truncated. Default true. */
    active?: boolean;
    /** When the transcript was last written (epoch ms): the last-turn clock where no `tail` reads one. */
    mtimeMs?: number;
}

export interface AgentSessionTail {
    lastUserMessage: string | null;
    lastActivityAt: number | null;
}

/** What one coding agent contributes to `who`. */
export interface AgentWhoSource {
    alias: AccountProviderAlias;
    /** The process kind, or null when this `ps` line is not this agent. */
    classify(args: string): string | null;
    /** Kinds that are machinery rather than billable sessions; hidden unless `--all`. */
    helperKinds?: readonly string[];
    /** A helper decided from the whole table (Claude: an SDK launcher sharing a TUI's tty). */
    isHelper?(process: Omit<ActiveAgentProcess, "args">, all: readonly Omit<ActiveAgentProcess, "args">[]): boolean;
    /** The session id the process names on its own argv (`--resume <id>`, `-r <id>`, `resume <id>`), or null. */
    resumeIdFromArgs?(args: string): string | null;
    /** The explicitly selected launch model, when the agent exposes one. */
    modelFromArgs?(args: string): string | null;
    /** Known sessions with their folder and name; those marked `active` take part in the cwd rung. */
    activeSessions?(): Promise<AgentSessionFacts[]>;
    /** The last user message and the last activity of one session. */
    tail?(session: AgentSessionFacts): Promise<AgentSessionTail>;
}

/** How long after its last write a session still counts as live for the cwd rung. */
const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * An agent's sessions from its history adapter (the shared index, read only): each name, folder and transcript
 * clock. The default `activeSessions` for an agent whose plugin has no richer reader.
 */
export async function sessionsFromAdapter(
    adapter: Pick<AgentSessionAdapter, "list" | "listCached">,
    now: number = Date.now()
): Promise<AgentSessionFacts[]> {
    const filters = { all: true, since: new Date(now - 7 * 24 * 60 * 60 * 1000), limit: 500 };
    const sessions = (await adapter.listCached?.(filters)) ?? (await adapter.list(filters));
    // A full page may omit a second active session in the same cwd; only stronger evidence can name its rows.
    const complete = sessions.length < filters.limit;

    return sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd || null,
        title: session.title || null,
        filePath: session.filePath,
        mtimeMs: session.mtime.getTime(),
        active: complete && now - session.mtime.getTime() < ACTIVE_WINDOW_MS,
    }));
}

export interface ActiveAgentSession extends Omit<ActiveAgentProcess, "args"> {
    resumeId: string | null;
    model: string | null;
    /** Resolved session id, or null when it cannot be told without guessing. */
    sessionId: string | null;
    /** How many active sessions were candidates (for the "? (n)" cell). */
    sessionCandidates: number;
    sessionSource: SessionIdSource;
    /** The cmux surface (tab) this process runs in, by tty: its UUID, and its `surface:N` for display. */
    surfaceId: string | null;
    surfaceRef: string | null;
    /** How many live processes resolved to the same session (two panes on one session). */
    sessionInstances: number;
    sessionTitle: string | null;
    lastUserMessage: string | null;
    lastActivityAt: number | null;
}

export type SessionIdSource = "resume-arg" | "hook-tty" | "cwd-unique" | "none";

export interface SessionIdAssignment {
    sessionId: string | null;
    candidates: number;
    source: SessionIdSource;
}

/** The live terminal surfaces, from `cmux --json --id-format both tree --all`: tty by surface UUID, and each one's ref. */
export interface CmuxSurfaceTtys {
    /** Surface UUID (lower case) → tty. The journal records the UUID; a ref is renumbered at each relaunch. */
    ttyBySurfaceId: Map<string, string>;
    /** Surface UUID (lower case) → `surface:N`, for display. */
    refBySurfaceId: Map<string, string>;
}

/**
 * The link the hook journal is missing: it records which cmux SURFACE a session runs on, but a
 * surface means nothing to `ps`. The tty is the shared key.
 */
export function parseCmuxTreeTtys(json: string): CmuxSurfaceTtys {
    const ttyBySurfaceId = new Map<string, string>();
    const refBySurfaceId = new Map<string, string>();
    const parsed: unknown = SafeJSON.parse(json, { strict: true });
    const list = (value: unknown, key: string): unknown[] => {
        const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : null;
        return Array.isArray(field) ? field : [];
    };

    for (const window of list(parsed, "windows")) {
        for (const workspace of list(window, "workspaces")) {
            for (const pane of list(workspace, "panes")) {
                for (const surface of list(pane, "surfaces")) {
                    const { id, ref, tty } = surface as { id?: unknown; ref?: unknown; tty?: unknown };

                    if (typeof id !== "string" || typeof tty !== "string" || !tty) {
                        continue;
                    }

                    ttyBySurfaceId.set(id.toLowerCase(), tty);

                    if (typeof ref === "string") {
                        refBySurfaceId.set(id.toLowerCase(), ref);
                    }
                }
            }
        }
    }

    return { ttyBySurfaceId, refBySurfaceId };
}

export interface SessionHint {
    sessionId: string;
    tty: string;
    cwd: string | null;
}

/**
 * Session → tty, by joining the hook journal to the live cmux surfaces by surface UUID.
 *
 * Only the UUID: a surface REF is renumbered when cmux restarts, so a journal line's ref can
 * name a tab another session owns now. `assignSessionIds` additionally requires the cwd to agree.
 */
export function buildSessionHints(
    refs: Map<string, SessionCmuxRefs>,
    ttyBySurfaceId: Map<string, string>
): SessionHint[] {
    const hints: SessionHint[] = [];

    for (const [sessionId, entry] of refs) {
        const tty = entry.surfaceId ? ttyBySurfaceId.get(entry.surfaceId.toLowerCase()) : undefined;

        if (tty) {
            hints.push({ sessionId, tty, cwd: entry.cwd });
        }
    }

    return hints;
}

/**
 * Pin each process to a session id, strongest evidence first:
 *
 * 1. `--resume <id>` in argv — the process says so itself.
 * 2. The SessionStart hook's journal, joined to the live cmux surface list by tty. This is
 *    the only source that knows a fresh, never-resumed session's id, which is why `who`
 *    used to print "—" for exactly the panes you most wanted to identify.
 * 3. A cwd with exactly one unclaimed active session and one unresolved process.
 *
 * Anything else stays null with the candidate count, because guessing here would point
 * `cmux focus` at the wrong pane.
 */
export function assignSessionIds(
    procs: Array<{ pid: number; cwd: string | null; resumeId: string | null; tty?: string }>,
    activeSessions: Array<{ sessionId: string; cwd: string | null }>,
    hints: SessionHint[] = []
): Map<number, SessionIdAssignment> {
    const result = new Map<number, SessionIdAssignment>();
    const claimed = new Set<string>();

    for (const proc of procs) {
        if (proc.resumeId) {
            result.set(proc.pid, { sessionId: proc.resumeId, candidates: 1, source: "resume-arg" });
            claimed.add(proc.resumeId);
        }
    }

    // A tty hosts one interactive session at a time, so a tty shared by two hints means the
    // journal is stale for at least one of them. Dropping both beats picking the wrong one.
    const ttyCounts = new Map<string, number>();

    for (const hint of hints) {
        ttyCounts.set(hint.tty, (ttyCounts.get(hint.tty) ?? 0) + 1);
    }

    const hintByTty = new Map<string, SessionHint>();

    for (const hint of hints) {
        if (ttyCounts.get(hint.tty) === 1 && !claimed.has(hint.sessionId)) {
            hintByTty.set(hint.tty, hint);
        }
    }

    for (const proc of procs) {
        if (result.has(proc.pid) || !proc.tty) {
            continue;
        }

        const hint = hintByTty.get(proc.tty);

        if (!hint || claimed.has(hint.sessionId)) {
            continue;
        }

        // Corroboration: a renumbered surface ref can name the wrong session, and a wrong
        // id here sends `focus` to someone else's pane. Matching cwds makes that a
        // two-signal agreement rather than a lookup.
        if (hint.cwd && proc.cwd && hint.cwd !== proc.cwd) {
            continue;
        }

        result.set(proc.pid, { sessionId: hint.sessionId, candidates: 1, source: "hook-tty" });
        claimed.add(hint.sessionId);
    }

    const byCwd = new Map<string, string[]>();

    for (const session of activeSessions) {
        if (!session.cwd || claimed.has(session.sessionId)) {
            continue;
        }

        const list = byCwd.get(session.cwd) ?? [];
        list.push(session.sessionId);
        byCwd.set(session.cwd, list);
    }

    const unresolved = procs.filter((proc) => !result.has(proc.pid));

    for (const proc of unresolved) {
        const candidates = proc.cwd ? (byCwd.get(proc.cwd) ?? []) : [];
        const siblings = unresolved.filter((other) => other.cwd === proc.cwd).length;

        if (candidates.length === 1 && siblings === 1) {
            result.set(proc.pid, { sessionId: candidates[0], candidates: 1, source: "cwd-unique" });
        } else {
            result.set(proc.pid, { sessionId: null, candidates: candidates.length, source: "none" });
        }
    }

    return result;
}

/** tty → the surface's display ref (`surface:N`), from the UUID-keyed maps. */
export function invertSurfaceTtys(surfaces: CmuxSurfaceTtys): Map<string, string> {
    const surfaceByTty = new Map<string, string>();

    for (const [surfaceId, tty] of surfaces.ttyBySurfaceId) {
        const surfaceRef = surfaces.refBySurfaceId.get(surfaceId) ?? surfaceId;
        // A tty belongs to exactly one surface; a duplicate means the listing is mid-change,
        // and naming either one would be a guess.
        if (surfaceByTty.has(tty)) {
            surfaceByTty.set(tty, "");
            continue;
        }

        surfaceByTty.set(tty, surfaceRef);
    }

    return surfaceByTty;
}

/** Count of live processes per session id, so a twice-opened session is visible. */
export function countSessionInstances(sessionIds: Array<string | null>): Map<string, number> {
    const counts = new Map<string, number>();

    for (const id of sessionIds) {
        if (id) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }

    return counts;
}

/**
 * Newest journal line per session of this agent. A record carries its `provider`; an untagged one predates the tag
 * and is Claude's. A Codex or Grok session started inside a Claude tab inherits the tab, so reading another
 * agent's line as this agent's would claim the tab twice, and `assignSessionIds` then drops both hints.
 */
function journalOf(alias: AccountProviderAlias): Map<string, SessionCmuxRefs> {
    const own = new Map<string, SessionCmuxRefs>();

    for (const [sessionId, entry] of loadAllSessionCmuxRefs()) {
        if ((entry.provider ?? "claude") === alias && !entry.ended) {
            own.set(sessionId, entry);
        }
    }

    return own;
}

interface CmuxContext {
    hints: SessionHint[];
    surfaces: CmuxSurfaceTtys;
    surfaceByTty: Map<string, string>;
}

/** Journal + live cmux surfaces. Both are optional: no cmux simply means no hints. */
async function readCmuxContext(
    alias: AccountProviderAlias,
    runner: (cmd: string[]) => Promise<string>
): Promise<CmuxContext> {
    const empty: CmuxContext = {
        hints: [],
        surfaces: { ttyBySurfaceId: new Map(), refBySurfaceId: new Map() },
        surfaceByTty: new Map(),
    };

    try {
        const surfaces = parseCmuxTreeTtys(await runner(["cmux", "--json", "--id-format", "both", "tree", "--all"]));
        return {
            hints: buildSessionHints(journalOf(alias), surfaces.ttyBySurfaceId),
            surfaces,
            surfaceByTty: invertSurfaceTtys(surfaces),
        };
    } catch (error) {
        logger.debug({ error, alias }, "[who] cmux session hints unavailable");
        return empty;
    }
}

export async function listActiveAgentSessions(
    source: AgentWhoSource,
    deps: { runner?: (cmd: string[]) => Promise<string> } = {}
): Promise<ActiveAgentSession[]> {
    const scanned = await listActiveAgentProcesses({ alias: source.alias, classify: source.classify });

    if (scanned.length === 0) {
        return [];
    }

    const procs = scanned.map((row) => ({
        ...row,
        resumeId: source.resumeIdFromArgs?.(row.args) ?? null,
        model: source.modelFromArgs?.(row.args) ?? null,
    }));
    let active: AgentSessionFacts[] = [];

    try {
        active = (await source.activeSessions?.()) ?? [];
    } catch (error) {
        logger.debug({ error, alias: source.alias }, "[who] active session listing failed; ids limited to argv");
    }

    const factsById = new Map(active.map((session) => [session.sessionId, session]));
    const cmux = await readCmuxContext(source.alias, deps.runner ?? runCapture);
    const assignments = assignSessionIds(
        withoutHelpers(source, procs),
        active.filter((session) => session.active !== false),
        cmux.hints
    );
    // Only TUI processes count: a helper shares its parent's tty, and counting it would report
    // every ordinary session as "open twice".
    const instances = countSessionInstances(
        procs.filter((proc) => proc.kind === "tui").map((proc) => assignments.get(proc.pid)?.sessionId ?? null)
    );

    // Only resolved sessions get a tail read: an unresolved pid has no single transcript to quote,
    // and guessing one would attribute another session's prompt to this process.
    const tails = new Map<string, AgentSessionTail>();
    const resolved = [...new Set([...assignments.values()].map((a) => a.sessionId))].filter(
        (id): id is string => id !== null
    );
    await Promise.all(
        resolved.map(async (sessionId) => {
            const facts = factsById.get(sessionId);

            if (facts && source.tail) {
                tails.set(sessionId, await source.tail(facts));
            } else if (facts?.mtimeMs !== undefined) {
                tails.set(sessionId, { lastUserMessage: null, lastActivityAt: facts.mtimeMs });
            }
        })
    );
    const surfaceIdByTty = new Map(
        [...cmux.surfaces.ttyBySurfaceId].map(([surfaceId, tty]) => [tty, surfaceId] as const)
    );

    return procs.map((proc) => {
        const assignment: SessionIdAssignment = assignments.get(proc.pid) ?? {
            sessionId: null,
            candidates: 0,
            source: "none",
        };
        const tail = assignment.sessionId ? tails.get(assignment.sessionId) : undefined;
        const surfaceRef = cmux.surfaceByTty.get(proc.tty) || null;

        return {
            pid: proc.pid,
            ppid: proc.ppid,
            tty: proc.tty,
            startedAt: proc.startedAt,
            cpuTime: proc.cpuTime,
            kind: proc.kind,
            account: proc.account,
            proxyTarget: proc.proxyTarget,
            cwd: proc.cwd,
            resumeId: proc.resumeId,
            model: proc.model,
            sessionId: assignment.sessionId,
            sessionCandidates: assignment.candidates,
            sessionSource: assignment.source,
            surfaceId: surfaceRef ? (surfaceIdByTty.get(proc.tty) ?? null) : null,
            surfaceRef,
            sessionInstances: assignment.sessionId ? (instances.get(assignment.sessionId) ?? 1) : 0,
            sessionTitle: assignment.sessionId ? (factsById.get(assignment.sessionId)?.title ?? null) : null,
            lastUserMessage: tail?.lastUserMessage ?? null,
            lastActivityAt: tail?.lastActivityAt ?? null,
        };
    });
}

/** The processes `who` lists without `--all`: no helper kinds and no table-decided helpers. */
export function withoutHelpers<T extends Omit<ActiveAgentProcess, "args">>(source: AgentWhoSource, all: T[]): T[] {
    const helperKinds = new Set(source.helperKinds ?? []);
    return all.filter((entry) => !helperKinds.has(entry.kind) && !source.isHelper?.(entry, all));
}

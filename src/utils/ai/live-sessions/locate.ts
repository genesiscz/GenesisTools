import { loadPins, type SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import {
    ACCOUNT_PROVIDER_ALIASES,
    type AccountProviderAlias,
    isAccountProviderAlias,
} from "@genesiscz/utils/ai/providers/alias-list";
import { findSessionsByTitle, type TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { type CmuxTreeView, liveTree } from "@genesiscz/utils/cmux/live-layout";
import {
    joinTmuxPanes,
    type LiveAgentSurface,
    liveAgentSurfaces,
    type TmuxPaneSurface,
    ttyName,
} from "@genesiscz/utils/cmux/live-surfaces";
import { loadAllSessionCmuxRefs, resolveRefsProvider, type SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";
import { classifyCommand, runsAgent } from "@genesiscz/utils/process/classify";
import { listProcesses, type ProcessEntry } from "@genesiscz/utils/process/processes";
import { listTmuxClients, listTmuxPanes } from "@genesiscz/utils/tmux/sessions";

/**
 * Which agent sessions run on this Mac now, and where: the one locator. One refresh reads the process table, the cmux
 * tree (with the tmux panes its surfaces show), the cmux-refs journal and the session pins once each, and returns one
 * row per live session with the evidence that matched it. A surface row without a pid (the agent's process could not
 * be told apart on its tty) and a pid row without a surface (a session outside cmux, or the caller's own tab) are both
 * legal. A DIAGNOSTIC: it reads and never writes.
 */

const log = logger.child({ component: "live-sessions" });

/**
 * How a row was found:
 * - `journal`: the cmux-refs journal names the session on a surface that still shows it (by surface UUID);
 * - `title`: no journal line, but the tab title names exactly one native session;
 * - `argv`: no surface, but the agent's command line names the session (`--resume <id>`);
 * - `process`: an agent process with no surface and no session id on its command line.
 */
export type LiveSessionMatch = "journal" | "title" | "argv" | "process";

/** One agent process from the process table: the agent binary itself, never a wrapper or one of its services. */
export interface LiveAgentProcess {
    pid: number;
    ppid: number;
    /** `ttys012`, no `/dev/`; null for a headless run. */
    tty: string | null;
    provider: AccountProviderAlias;
    /** The session id its command line names, lowercased. */
    argvSessionId: string | null;
    startMs: number | null;
    command: string;
}

export interface LiveSessionRow {
    provider: AccountProviderAlias;
    /** Null only for a `process` row. */
    sessionId: string | null;
    match: LiveSessionMatch;
    surface: LiveAgentSurface | null;
    process: LiveAgentProcess | null;
    cwd: string | null;
    /** Set when the title match already found the transcript. */
    transcriptPath: string | null;
}

/** The reads of one refresh. `liveSessionReads()` is the real set; a test passes fakes. */
export interface LiveSessionReads {
    tree(): Promise<CmuxTreeView>;
    tmux(tree: CmuxTreeView): Promise<ReadonlyMap<string, TmuxPaneSurface>>;
    journal(): Iterable<SessionCmuxRefs>;
    pins(): Promise<ReadonlyMap<string, Pick<SessionPin, "provider">>>;
    processes(): ProcessEntry[];
    /** This user's uid: an agent never runs as another user, and root's `login` holds nearly every terminal. */
    uid(): number | undefined;
    titles(query: string, provider: AccountProviderAlias): TitledSession[];
}

const EMPTY_TREE: CmuxTreeView = { caller: null, callerId: null, surfaces: new Map() };

/**
 * Which cmux surface shows each tmux pane. The listings are bounded; when tmux does not answer, no tmux-only session
 * is found, which is the safe side for a read-only lookup.
 */
export async function readTmuxJoin(tree: CmuxTreeView): Promise<Map<string, TmuxPaneSurface>> {
    const [panes, clients] = await Promise.all([listTmuxPanes(), listTmuxClients()]);

    if (!panes.ok || !clients.ok) {
        log.debug(
            { panes: panes.ok ? null : panes.reason, clients: clients.ok ? null : clients.reason },
            "tmux did not answer; --via-tmux sessions are not discoverable this time"
        );
        return new Map();
    }

    return joinTmuxPanes({ panes: panes.items, clients: clients.items, tree });
}

/** The real reads. No cmux means an empty tree: processes still answer. */
export function liveSessionReads(): LiveSessionReads {
    return {
        tree: async () => {
            try {
                return await liveTree();
            } catch (error) {
                log.debug({ error }, "cmux tree unavailable; only processes locate sessions");
                return EMPTY_TREE;
            }
        },
        tmux: readTmuxJoin,
        journal: () => loadAllSessionCmuxRefs().values(),
        pins: () => loadPins({ readOnly: true }),
        processes: () => listProcesses(),
        uid: () => globalThis.process.getuid?.(),
        titles: (query, provider) => findSessionsByTitle(query, { provider }),
    };
}

function ownLive(entry: ProcessEntry, uid: number | undefined): entry is ProcessEntry & { command: string } {
    return entry.command !== null && !entry.zombie && (uid === undefined || entry.uid === uid);
}

/** The agents this user runs on each tty, by command line (binary, wrapper or `tools <agent>` launcher). */
export function agentsByTty(
    processes: readonly ProcessEntry[],
    uid: number | undefined
): Map<string, Set<AccountProviderAlias>> {
    const agents = new Map<string, Set<AccountProviderAlias>>();

    for (const entry of processes) {
        if (!entry.tty || !ownLive(entry, uid)) {
            continue;
        }

        const tty = ttyName(entry.tty) ?? entry.tty;

        for (const agent of ACCOUNT_PROVIDER_ALIASES) {
            if (runsAgent(entry.command, agent)) {
                agents.set(tty, (agents.get(tty) ?? new Set()).add(agent));
            }
        }
    }

    return agents;
}

/**
 * The agent processes of this user, one per running agent: the agent binary (not a wrapper, not an MCP or app-server
 * service), and of a parent and child that are both the same agent only the parent (a node launcher and its native
 * binary are one session).
 */
export function liveAgentProcesses(processes: readonly ProcessEntry[], uid: number | undefined): LiveAgentProcess[] {
    const found: LiveAgentProcess[] = [];

    for (const entry of processes) {
        if (!ownLive(entry, uid)) {
            continue;
        }

        const proc = classifyCommand(entry.command);

        if (proc.kind !== "agent" || proc.service || !proc.provider || !isAccountProviderAlias(proc.provider)) {
            continue;
        }

        found.push({
            pid: entry.pid,
            ppid: entry.ppid,
            tty: entry.tty ? ttyName(entry.tty) : null,
            provider: proc.provider,
            argvSessionId: proc.sessionId?.toLowerCase() ?? null,
            startMs: entry.startMs,
            command: entry.command,
        });
    }

    const key = (pid: number, provider: AccountProviderAlias) => `${pid}\u0000${provider}`;
    const agents = new Set(found.map((proc) => key(proc.pid, proc.provider)));
    return found.filter((proc) => !agents.has(key(proc.ppid, proc.provider)));
}

/**
 * The pure join: each surface session claims the agent process of its provider on its terminal's tty (the pane's tty
 * for a `--via-tmux` session), or the one whose command line names it; every unclaimed process becomes a row of its
 * own.
 */
export function joinLiveSessions(input: {
    surfaces: readonly LiveAgentSurface[];
    processes: readonly LiveAgentProcess[];
}): LiveSessionRow[] {
    const claimed = new Set<number>();
    const rows: LiveSessionRow[] = [];

    for (const surface of input.surfaces) {
        const tty = surface.tmux?.paneTty ?? ttyName(surface.surface.tty);
        const sessionId = surface.sessionId.toLowerCase();
        const candidates = input.processes.filter((proc) => proc.provider === surface.agent && !claimed.has(proc.pid));
        const onTty = candidates.filter((proc) => tty !== null && proc.tty === tty);
        // Several agents of one kind on one tty: the one its command line names, else none (no guess).
        const process =
            candidates.find((proc) => proc.argvSessionId === sessionId) ?? (onTty.length === 1 ? onTty[0] : null);

        if (process) {
            claimed.add(process.pid);
        }

        rows.push({
            provider: surface.agent,
            sessionId: surface.sessionId,
            match: surface.transcriptPath ? "title" : "journal",
            surface,
            process,
            cwd: surface.cwd,
            transcriptPath: surface.transcriptPath ?? null,
        });
    }

    for (const process of input.processes) {
        if (claimed.has(process.pid)) {
            continue;
        }

        rows.push({
            provider: process.provider,
            sessionId: process.argvSessionId,
            match: process.argvSessionId ? "argv" : "process",
            surface: null,
            process,
            cwd: null,
            transcriptPath: null,
        });
    }

    return rows;
}

export interface LocateOptions {
    reads?: LiveSessionReads;
    /**
     * The keys a tab title is tried by. The cmux tool passes its harness-aware `titleMatchKeys`; without it a session
     * the journal does not know is found only by its process.
     */
    titleKeys?: (title: string, agent: AccountProviderAlias) => string[];
}

/** The surface sessions of one refresh: the journal join, then tab titles for sessions without a journal line. */
export async function locateLiveSurfaces(
    reads: LiveSessionReads,
    processes: readonly ProcessEntry[],
    titleKeys: LocateOptions["titleKeys"]
): Promise<LiveAgentSurface[]> {
    const tree = await reads.tree();
    const [tmux, pins] = await Promise.all([reads.tmux(tree), reads.pins()]);
    const agents = agentsByTty(processes, reads.uid());

    return liveAgentSurfaces({
        refs: reads.journal(),
        tree,
        tmux,
        providerOf: (entry) => resolveRefsProvider(entry, pins.get(entry.sessionId)),
        agentOnTty: (tty) => {
            const found = agents.get(ttyName(tty) ?? tty);
            return found?.size === 1 ? [...found][0] : undefined;
        },
        titles: reads.titles,
        ...(titleKeys ? { titleKeys } : {}),
    });
}

/** Every live agent session now, one row each. Each source is read once. */
export async function locateLiveSessions(options: LocateOptions = {}): Promise<LiveSessionRow[]> {
    const reads = options.reads ?? liveSessionReads();
    const processes = reads.processes();
    const surfaces = await locateLiveSurfaces(reads, processes, options.titleKeys);
    const rows = joinLiveSessions({ surfaces, processes: liveAgentProcesses(processes, reads.uid()) });
    log.debug(
        {
            rows: rows.length,
            bySource: Object.fromEntries(
                (["journal", "title", "argv", "process"] as const).map((match) => [
                    match,
                    rows.filter((row) => row.match === match).length,
                ])
            ),
        },
        "located live sessions"
    );
    return rows;
}

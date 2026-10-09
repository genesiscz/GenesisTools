import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import type { TmuxClientInfo, TmuxPaneInfo } from "@genesiscz/utils/tmux/sessions";
import { isSessionAgentId, type SessionAgentId } from "./session-agents";
import type { AdoptedSession } from "./session-close";

export interface LiveSurface {
    ref: string;
    /** The surface UUID (`--id-format both`); stable across cmux restarts, unlike `ref`. */
    id: string | null;
    tty: string | null;
    workspace: string;
    /** The workspace UUID (`--id-format both`); stable across cmux restarts, unlike `workspace`. */
    workspaceId: string | null;
    window: string;
    /** The tab title (`vybava - grok`). */
    title: string | null;
    workspaceTitle: string | null;
}

export interface CmuxTreeView {
    /** The surface this command runs in; never adopted. */
    caller: string | null;
    surfaces: Map<string, LiveSurface>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** The terminal surfaces of `cmux --id-format both tree --json`, keyed by ref, with their UUID, tty, workspace and window. */
export function parseCmuxTree(stdout: string): CmuxTreeView {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
    const surfaces = new Map<string, LiveSurface>();

    if (!isRecord(parsed)) {
        return { caller: null, surfaces };
    }

    const caller = isRecord(parsed.caller) ? text(parsed.caller.surface_ref) : null;

    for (const window of list(parsed.windows)) {
        if (!isRecord(window) || !text(window.ref)) {
            continue;
        }

        for (const workspace of list(window.workspaces)) {
            if (!isRecord(workspace) || !text(workspace.ref)) {
                continue;
            }

            for (const pane of list(workspace.panes)) {
                if (!isRecord(pane)) {
                    continue;
                }

                for (const surface of list(pane.surfaces)) {
                    const ref = isRecord(surface) ? text(surface.ref) : null;

                    if (isRecord(surface) && ref && surface.type === "terminal") {
                        surfaces.set(ref, {
                            ref,
                            id: text(surface.id),
                            tty: text(surface.tty),
                            workspace: String(workspace.ref),
                            workspaceId: text(workspace.id),
                            window: String(window.ref),
                            title: text(surface.title),
                            workspaceTitle: text(workspace.title),
                        });
                    }
                }
            }
        }
    }

    return { caller, surfaces };
}

/**
 * A tmux pane a cmux surface shows right now: the surface's tty is the tty of the only tmux client attached to
 * the pane's session, and the pane is the one that client displays (active pane of the active window).
 */
export interface TmuxPaneSurface {
    pane: string;
    session: string;
    /** The surface ref showing the pane. */
    surface: string;
    /** The pane's own tty, where the agent process runs (the surface's tty runs `tmux attach`). */
    paneTty: string | null;
    sessionCreatedMs: number;
}

/** `/dev/ttys012` (tmux) and `ttys012` (cmux) name the same terminal. */
function ttyName(tty: string | null): string | null {
    return tty ? tty.replace(/^\/dev\//, "") : null;
}

/**
 * Which cmux surface shows each visible tmux pane, joined live through the attached client's tty. A session
 * with no client in cmux, or with clients in several surfaces, joins nothing: there is no single surface to
 * type into.
 */
export function joinTmuxPanes(input: {
    panes: readonly TmuxPaneInfo[];
    clients: readonly TmuxClientInfo[];
    tree: CmuxTreeView;
}): Map<string, TmuxPaneSurface> {
    const surfaceByTty = new Map<string, string>();

    for (const surface of input.tree.surfaces.values()) {
        const tty = ttyName(surface.tty);

        if (tty) {
            surfaceByTty.set(tty, surface.ref);
        }
    }

    const surfacesBySession = new Map<string, Set<string>>();

    for (const client of input.clients) {
        const surface = surfaceByTty.get(ttyName(client.tty) ?? "");

        if (surface) {
            surfacesBySession.set(client.session, (surfacesBySession.get(client.session) ?? new Set()).add(surface));
        }
    }

    const joined = new Map<string, TmuxPaneSurface>();

    for (const pane of input.panes) {
        const surfaces = surfacesBySession.get(pane.session);

        if (pane.visible && surfaces?.size === 1) {
            joined.set(pane.pane, {
                pane: pane.pane,
                session: pane.session,
                surface: [...surfaces][0],
                paneTty: ttyName(pane.tty),
                sessionCreatedMs: pane.sessionCreatedMs,
            });
        }
    }

    return joined;
}

/** tmux stamps `session_created` in whole seconds; the journal in milliseconds. */
const TMUX_CREATED_SLACK_MS = 1_000;

interface ResolvedEntry {
    entry: SessionCmuxRefs;
    live: LiveSurface & { id: string };
    /** Set when the entry was joined through its tmux pane (a --via-tmux session records no surface). */
    tmux: TmuxPaneSurface | null;
}

/**
 * The live surface a journal entry still runs in, or null.
 *
 * A ref is only meaningful inside one cmux instance: after a restart `surface:5` can name an unrelated
 * terminal, and closing it would `/exit` and close someone else's work. So the ref only finds the
 * candidate, and the journal's surface UUID must equal the live surface's UUID. An entry or a tree
 * without a UUID is never trusted. The caller's own surface is never returned.
 *
 * An entry with no surface but a tmux pane (a --via-tmux session started without the caller's cmux identity)
 * resolves through `tmux`: the surface that shows that pane now. tmux pane ids renumber when the tmux server
 * restarts, so an entry older than the pane's session is not trusted.
 */
function resolveEntry(
    entry: SessionCmuxRefs,
    tree: CmuxTreeView,
    tmux: ReadonlyMap<string, TmuxPaneSurface>
): ResolvedEntry | null {
    const joined = !entry.surfaceRef && entry.tmuxPane ? (tmux.get(entry.tmuxPane) ?? null) : null;
    const ref = entry.surfaceRef ?? joined?.surface;

    if (!ref || ref === tree.caller) {
        return null;
    }

    const live = tree.surfaces.get(ref);

    if (!live?.id) {
        return null;
    }

    if (joined) {
        return entry.at >= joined.sessionCreatedMs - TMUX_CREATED_SLACK_MS
            ? { entry, live: { ...live, id: live.id }, tmux: joined }
            : null;
    }

    if (!entry.surfaceId || live.id.toLowerCase() !== entry.surfaceId.toLowerCase()) {
        return null;
    }

    return { entry, live: { ...live, id: live.id }, tmux: null };
}

/** The newest journal entry per live surface, keyed by ref, keeping only entries that still resolve to it. */
function newestPerLiveSurface(input: {
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
}): Map<string, ResolvedEntry> {
    const newest = new Map<string, ResolvedEntry>();

    for (const entry of input.refs) {
        const resolved = resolveEntry(entry, input.tree, input.tmux ?? new Map());

        if (!resolved) {
            continue;
        }

        const seen = newest.get(resolved.live.ref);

        if (!seen || entry.at > seen.entry.at) {
            newest.set(resolved.live.ref, resolved);
        }
    }

    return newest;
}

/**
 * The live agent session a query names, from the cmux-refs journal joined with the live tree.
 *
 * The query is a session id (or a prefix of 8+ characters), a surface ref, or a workspace ref. Only the
 * newest session per surface counts (a surface that ran several sessions holds the last one), only
 * surfaces cmux still lists under the same surface UUID count, and the caller's own surface never does. A workspace ref adopts only
 * when exactly one agent session lives in it. `providerOf` names the agent; an entry it cannot name is
 * skipped rather than guessed, because `/exit` typed into the wrong agent is not harmless.
 */
export function pickAdoptable(input: {
    query: string;
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
}): AdoptedSession | null {
    const needle = input.query.trim().toLowerCase();
    const hits = [...newestPerLiveSurface(input).values()].filter(({ entry, live }) => {
        const id = entry.sessionId.toLowerCase();
        return (
            id === needle ||
            (needle.length >= 8 && id.startsWith(needle)) ||
            live.ref === input.query ||
            live.workspace === input.query
        );
    });

    if (hits.length !== 1) {
        return null;
    }

    const agent = input.providerOf(hits[0].entry);

    if (!agent || !isSessionAgentId(agent)) {
        return null;
    }

    return adoptedFrom(hits[0], agent);
}

function adoptedFrom({ entry, live, tmux }: ResolvedEntry, agent: SessionAgentId): AdoptedSession {
    return {
        type: "created",
        name: entry.sessionId,
        sessionId: entry.sessionId,
        agent,
        account: "",
        model: null,
        cwd: entry.cwd ?? "",
        window: live.window,
        workspace: live.workspace,
        surface: live.ref,
        workspaceId: live.workspaceId,
        surfaceId: live.id,
        // A tmux-joined session quits through tmux and runs on the pane's tty, not on the surface's.
        tmuxSession: tmux?.session ?? null,
        pidFile: "",
        command: "",
        createdAt: new Date(entry.at).toISOString(),
        createdBy: "adopted",
        tty: tmux ? tmux.paneTty : live.tty,
    };
}

/** Does a `ps -t <tty> -o args=` listing show the agent? Its binary, or the `tools <agent>` launcher. */
export function ttyRunsAgent(psArgs: string, agent: SessionAgentId): boolean {
    const word = new RegExp(`(^|[\\s/])${agent}(\\s|$)`);
    return psArgs.split("\n").some((line) => word.test(line.trim()));
}

export interface LiveAgentSurface {
    sessionId: string;
    agent: SessionAgentId;
    surface: LiveSurface;
    cwd: string | null;
}

/** The newest agent session of each live surface (caller excluded), with the agent named. */
export function liveAgentSurfaces(input: {
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
}): LiveAgentSurface[] {
    const found: LiveAgentSurface[] = [];

    for (const { entry, live } of newestPerLiveSurface(input).values()) {
        const agent = input.providerOf(entry);

        if (agent && isSessionAgentId(agent)) {
            found.push({ sessionId: entry.sessionId, agent, surface: live, cwd: entry.cwd });
        }
    }

    return found;
}

/**
 * Live sessions of one agent that a query names: the session id or an 8+ character prefix, else a
 * case-insensitive part of the tab title, the workspace title or the cwd's last folder.
 */
export function matchLiveAgentSurfaces(
    query: string,
    agent: SessionAgentId,
    live: readonly LiveAgentSurface[]
): LiveAgentSurface[] {
    const needle = query.trim().toLowerCase();
    const mine = live.filter((entry) => entry.agent === agent);
    const byId = mine.filter(
        (entry) =>
            entry.sessionId.toLowerCase() === needle ||
            (needle.length >= 8 && entry.sessionId.toLowerCase().startsWith(needle))
    );

    if (byId.length > 0 || needle === "") {
        return byId;
    }

    return mine.filter((entry) =>
        [entry.surface.title, entry.surface.workspaceTitle, entry.cwd?.split("/").pop() ?? null].some((value) =>
            value?.toLowerCase().includes(needle)
        )
    );
}

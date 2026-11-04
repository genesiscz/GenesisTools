import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import type { CmuxTreeView, LiveSurface } from "@genesiscz/utils/cmux/live-layout";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import type { TmuxClientInfo, TmuxPaneInfo } from "@genesiscz/utils/tmux/sessions";

/**
 * Which agent session each live cmux surface runs: the cmux-refs journal joined with the live tree (by surface UUID),
 * the tmux panes a surface shows, and the tab titles of sessions the journal does not know. Pure functions over the
 * reads `@genesiscz/utils/ai/live-sessions` makes once per refresh; the cmux tool's adoption and close reuse the same
 * join.
 */

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
export function ttyName(tty: string | null): string | null {
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

export interface ResolvedEntry {
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
    // The UUID first: cmux renumbers every `surface:N` ref at a relaunch, so the journal's ref names
    // nothing (or another tab) afterwards, while the UUID still names the tab the session ran in.
    const surfaceId = entry.surfaceId?.toLowerCase();
    const byUuid = surfaceId
        ? [...tree.surfaces.values()].find((surface) => surface.id?.toLowerCase() === surfaceId)
        : undefined;
    const ref = byUuid?.ref ?? entry.surfaceRef ?? joined?.surface;

    if (!ref) {
        return null;
    }

    const live = byUuid ?? tree.surfaces.get(ref);

    // The caller's own tab is never adopted; compared by UUID when the tree reported the caller's.
    const isCaller = tree.callerId ? live?.id?.toLowerCase() === tree.callerId.toLowerCase() : ref === tree.caller;

    if (!live?.id || isCaller) {
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
export function newestPerLiveSurface(input: {
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

export interface LiveAgentSurface {
    sessionId: string;
    /** Native transcript found without a journal record. */
    transcriptPath?: string;
    lastSeenAt?: number;
    agent: AccountProviderAlias;
    surface: LiveSurface;
    cwd: string | null;
    /** Set for a --via-tmux session: the surface only shows its pane while the tmux client displays it. */
    tmux?: TmuxPaneSurface | null;
}

/** Journal sessions plus uniquely identified native sessions without a hook record (caller excluded). */
export function liveAgentSurfaces(input: {
    refs: Iterable<SessionCmuxRefs>;
    tree: CmuxTreeView;
    tmux?: ReadonlyMap<string, TmuxPaneSurface>;
    providerOf: (entry: SessionCmuxRefs) => string | undefined;
    agentOnTty?: (tty: string) => AccountProviderAlias | undefined;
    /** The keys a tab title is tried by, most specific first (the cmux tool strips each harness's title chrome). */
    titleKeys?: (title: string, agent: AccountProviderAlias) => string[];
    titles?: (query: string, provider: AccountProviderAlias) => TitledSession[];
}): LiveAgentSurface[] {
    const found: LiveAgentSurface[] = [];

    for (const { entry, live, tmux } of newestPerLiveSurface(input).values()) {
        const agent = input.providerOf(entry);

        if (agent && isAccountProviderAlias(agent)) {
            found.push({
                sessionId: entry.sessionId,
                agent,
                surface: live,
                cwd: entry.cwd,
                tmux,
                lastSeenAt: entry.at,
            });
        }
    }

    const known = new Set(found.map((entry) => entry.surface.ref));
    for (const surface of input.tree.surfaces.values()) {
        if (
            known.has(surface.ref) ||
            surface.ref === input.tree.caller ||
            !surface.id ||
            !surface.tty ||
            !surface.title
        ) {
            continue;
        }

        const joined = [...(input.tmux?.values() ?? [])].find((pane) => pane.surface === surface.ref);
        const agent = input.agentOnTty?.(joined?.paneTty ?? surface.tty);
        if (!agent || !input.titles || !input.titleKeys) {
            continue;
        }

        for (const key of input.titleKeys(surface.title, agent)) {
            const hits = input.titles(key, agent);
            if (hits.length === 1) {
                found.push({
                    sessionId: hits[0].sessionId,
                    agent,
                    surface,
                    cwd: null,
                    tmux: joined ?? null,
                    transcriptPath: hits[0].locator,
                    lastSeenAt: hits[0].mtime,
                });
                break;
            }

            if (hits.length > 1) {
                break;
            }
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
    agent: AccountProviderAlias,
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

import type { CmuxLivePane, CmuxLiveSnapshot } from "@app/cmux/lib/live-snapshot";

interface TtydBinding {
    id: string;
    tmuxSessionName?: string;
}

/**
 * The tmux session name a cmux pane is bound to, if any. A cmux terminal surface's `title` IS the
 * tmux session name (see `indexCmuxSurfacesByTmuxSession`), so we read it off the pane's selected
 * terminal surface first, then fall back to any terminal surface, then the pane title.
 */
function paneTmuxSessionName(pane: CmuxLivePane): string | undefined {
    const terminals = pane.surfaces.filter((surface) => surface.type === "terminal");

    if (terminals.length === 0) {
        return undefined;
    }

    const selected = terminals.find((surface) => surface.id === pane.selectedSurfaceRef || surface.selected);
    const chosen = selected ?? terminals[0];

    return chosen?.title;
}

/**
 * Enrich each pane with the `ttydSessionId` of the ttyd terminal backing its tmux session, joined by
 * tmux session name (pane terminal-surface title === ttyd `tmuxSessionName`). Pure — the dev-dashboard
 * snapshot path calls it with `await listTtyd()` so the generic cmux module stays ttyd-agnostic. Panes
 * with no tmux-backed terminal (or no matching ttyd) are returned unchanged.
 */
export function enrichPanesWithTtyd(snapshot: CmuxLiveSnapshot, ttydSessions: TtydBinding[]): CmuxLiveSnapshot {
    const ttydByTmux = new Map<string, string>();

    for (const ttyd of ttydSessions) {
        if (ttyd.tmuxSessionName && !ttydByTmux.has(ttyd.tmuxSessionName)) {
            ttydByTmux.set(ttyd.tmuxSessionName, ttyd.id);
        }
    }

    if (ttydByTmux.size === 0) {
        return snapshot;
    }

    const panes = snapshot.panes.map((pane) => {
        const tmuxName = paneTmuxSessionName(pane);
        const ttydSessionId = tmuxName ? ttydByTmux.get(tmuxName) : undefined;

        if (!ttydSessionId) {
            return pane;
        }

        return { ...pane, ttydSessionId };
    });

    return { ...snapshot, panes };
}

/**
 * Resolve the ttyd session id whose tmux binding matches the title of the cmux surface about to be
 * renamed. A cmux terminal surface's title IS the tmux session name, so when that surface is renamed
 * we look it up in the CURRENT snapshot (before the rename lands) and join to ttyd by tmux name —
 * letting a cmux rename also drive the ttyd terminal's display name. Returns null when the surface
 * isn't a tmux-backed terminal or has no matching ttyd.
 */
export function resolveTtydForCmuxSurface(
    snapshot: CmuxLiveSnapshot,
    surfaceId: string,
    ttydSessions: TtydBinding[]
): string | null {
    let tmuxName: string | undefined;

    for (const pane of snapshot.panes) {
        const surface = pane.surfaces.find((s) => s.id === surfaceId && s.type === "terminal");

        if (surface) {
            tmuxName = surface.title;
            break;
        }
    }

    if (!tmuxName) {
        return null;
    }

    const match = ttydSessions.find((ttyd) => ttyd.tmuxSessionName === tmuxName);
    return match?.id ?? null;
}

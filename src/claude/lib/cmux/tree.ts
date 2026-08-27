import { TITLE_SHORT_ID_RE } from "@app/claude/lib/cmux/focus";
import { loadAllSessionCmuxRefs, type SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import {
    type CmuxLivePane,
    type CmuxLiveSnapshot,
    fetchCmuxLiveSnapshot,
} from "@genesiscz/utils/cmux/lib/live-snapshot";
import { buildCmuxHierarchy } from "@genesiscz/utils/cmux/lib/tree";
import { profiler } from "@genesiscz/utils/profile";

/**
 * The claude layer over the generic cmux hierarchy (src/utils/cmux/lib/tree.ts):
 * annotate every surface with the Claude Code session it hosts, from the refs
 * journal and the `· 8hex` tab-title marker. Enumeration only, no captures,
 * so it stays cheap enough to refresh on a timer.
 */

export interface CmuxTreeSurface {
    id: string;
    title: string;
    type: string;
    index: number;
    selected: boolean;
    active: boolean;
    /** Full session id when the refs journal pins this surface to a session. */
    sessionId: string | null;
    /** 8-char id from the tab-title marker when only the title says so. */
    sessionHint: string | null;
}

export interface CmuxTreePane {
    id: string;
    title: string;
    active: boolean;
    cwd?: string;
    selectedSurfaceId?: string;
    surfaces: CmuxTreeSurface[];
}

export interface CmuxTreeWorkspace {
    id: string;
    name: string;
    panes: CmuxTreePane[];
}

export interface CmuxTreeWindow {
    id: string;
    ref?: string;
    index: number;
    key: boolean;
    workspaces: CmuxTreeWorkspace[];
}

export interface CmuxTree {
    fetchedAt: string;
    available: boolean;
    error?: string;
    windows: CmuxTreeWindow[];
    totalMs: number;
}

interface TreeDeps {
    fetchSnapshot?: () => Promise<CmuxLiveSnapshot>;
    loadRefs?: () => Map<string, SessionCmuxRefs>;
}

/** surfaceId AND surfaceRef both key the session, whichever form the RPC reports. */
function surfaceSessionIndex(refs: Map<string, SessionCmuxRefs>): Map<string, string> {
    const index = new Map<string, string>();
    // Resuming a new session in a tab that hosted an older one leaves both
    // holding the same surface. Map iteration follows journal insertion order,
    // not recency, so without this the tree labelled the tab with the OLDER id.
    const seenAt = new Map<string, number>();

    for (const [sessionId, entry] of refs) {
        const at = entry.at ?? 0;

        for (const key of [entry.surfaceId, entry.surfaceRef]) {
            if (!key) {
                continue;
            }

            if (index.has(key) && (seenAt.get(key) ?? 0) >= at) {
                continue;
            }

            index.set(key, sessionId);
            seenAt.set(key, at);
        }
    }

    return index;
}

function toTreePane(pane: CmuxLivePane, bySurface: Map<string, string>): CmuxTreePane {
    return {
        id: pane.id,
        title: pane.title,
        active: pane.active,
        cwd: pane.cwd,
        selectedSurfaceId: pane.selectedSurfaceRef,
        surfaces: pane.surfaces.map((surface) => ({
            id: surface.id,
            title: surface.title,
            type: surface.type,
            index: surface.index,
            selected: surface.selected,
            active: surface.active,
            sessionId: bySurface.get(surface.id) ?? null,
            sessionHint: surface.title.match(TITLE_SHORT_ID_RE)?.[1]?.toLowerCase() ?? null,
        })),
    };
}

export async function fetchCmuxTree(deps: TreeDeps = {}): Promise<CmuxTree> {
    const prof = profiler.scope("claude-cmux-tree");
    const started = performance.now();
    const fetchSnapshot = deps.fetchSnapshot ?? (() => fetchCmuxLiveSnapshot({ previews: "none", allWindows: true }));
    const loadRefs = deps.loadRefs ?? loadAllSessionCmuxRefs;

    const snapshot = await prof.measureAsync("snapshot", fetchSnapshot);
    const bySurface = surfaceSessionIndex(prof.measure("refs", loadRefs));

    if (!snapshot.available) {
        return {
            fetchedAt: snapshot.fetchedAt,
            available: false,
            error: snapshot.error,
            windows: [],
            totalMs: performance.now() - started,
        };
    }

    const windows: CmuxTreeWindow[] = buildCmuxHierarchy(snapshot).map((window) => ({
        id: window.id,
        ref: window.ref,
        index: window.index,
        key: window.key,
        workspaces: window.workspaces.map((ws) => ({
            id: ws.id,
            name: ws.name,
            panes: ws.panes.map((p) => toTreePane(p, bySurface)),
        })),
    }));

    prof.summary("tree");

    return {
        fetchedAt: snapshot.fetchedAt,
        available: true,
        windows,
        totalMs: performance.now() - started,
    };
}

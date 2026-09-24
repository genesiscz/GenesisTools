import {
    type CmuxLivePane,
    type CmuxLiveSnapshot,
    type CmuxPaneFrame,
    fetchCmuxLiveSnapshot,
} from "@genesiscz/utils/cmux/lib/live-snapshot";
import { buildCmuxHierarchy } from "@genesiscz/utils/cmux/lib/tree";
import { profiler } from "@genesiscz/utils/profile";

/**
 * The live cmux hierarchy (window → workspace → pane → surface) with each pane's rectangle, and no
 * agent concepts. `tools cmux tree` prints it; `agent-tree.ts` layers session ids on top for
 * `tools ai cmux tree` and `tools claude cmux tree`.
 */
export interface CmuxTreeSurface {
    id: string;
    title: string;
    type: string;
    index: number;
    selected: boolean;
    active: boolean;
}

export interface CmuxTreePane<S extends CmuxTreeSurface = CmuxTreeSurface> {
    id: string;
    title: string;
    active: boolean;
    cwd?: string;
    selectedSurfaceId?: string;
    /** Pane rectangle inside the workspace, in points; with `container`, the real split layout. */
    frame?: CmuxPaneFrame;
    container?: { width: number; height: number };
    surfaces: S[];
}

export interface CmuxTreeWorkspace<S extends CmuxTreeSurface = CmuxTreeSurface> {
    id: string;
    name: string;
    panes: CmuxTreePane<S>[];
}

export interface CmuxTreeWindow<S extends CmuxTreeSurface = CmuxTreeSurface> {
    id: string;
    ref?: string;
    index: number;
    key: boolean;
    workspaces: CmuxTreeWorkspace<S>[];
}

export interface CmuxTree<S extends CmuxTreeSurface = CmuxTreeSurface> {
    fetchedAt: string;
    available: boolean;
    error?: string;
    windows: CmuxTreeWindow<S>[];
    totalMs: number;
}

export interface CmuxTreeDeps {
    fetchSnapshot?: () => Promise<CmuxLiveSnapshot>;
}

const prof = profiler.scope("cmux");

function toTreePane(pane: CmuxLivePane): CmuxTreePane {
    return {
        id: pane.id,
        title: pane.title,
        active: pane.active,
        cwd: pane.cwd,
        frame: pane.frame,
        container: pane.container,
        selectedSurfaceId: pane.selectedSurfaceRef,
        surfaces: pane.surfaces.map((surface) => ({
            id: surface.id,
            title: surface.title,
            type: surface.type,
            index: surface.index,
            selected: surface.selected,
            active: surface.active,
        })),
    };
}

/** Every window's hierarchy, from one live snapshot (no previews). */
export async function fetchCmuxTree(deps: CmuxTreeDeps = {}): Promise<CmuxTree> {
    const started = performance.now();
    const fetchSnapshot = deps.fetchSnapshot ?? (() => fetchCmuxLiveSnapshot({ previews: "none", allWindows: true }));
    const snapshot = await prof.measureAsync("tree.snapshot", fetchSnapshot);

    if (!snapshot.available) {
        return {
            fetchedAt: snapshot.fetchedAt,
            available: false,
            error: snapshot.error,
            windows: [],
            totalMs: performance.now() - started,
        };
    }

    const windows = buildCmuxHierarchy(snapshot).map((window) => ({
        id: window.id,
        ref: window.ref,
        index: window.index,
        key: window.key,
        workspaces: window.workspaces.map((ws) => ({ id: ws.id, name: ws.name, panes: ws.panes.map(toTreePane) })),
    }));

    return { fetchedAt: snapshot.fetchedAt, available: true, windows, totalMs: performance.now() - started };
}

/** The same tree with every surface replaced by `fn(surface)`; how the agent layer adds session ids. */
export function mapCmuxTreeSurfaces<S extends CmuxTreeSurface>(
    tree: CmuxTree,
    fn: (surface: CmuxTreeSurface) => S
): CmuxTree<S> {
    return {
        ...tree,
        windows: tree.windows.map((window) => ({
            ...window,
            workspaces: window.workspaces.map((ws) => ({
                ...ws,
                panes: ws.panes.map((pane) => ({ ...pane, surfaces: pane.surfaces.map(fn) })),
            })),
        })),
    };
}

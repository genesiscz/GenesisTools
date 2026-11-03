import { findCmuxAppPid } from "@genesiscz/utils/cmux/lib/health";
import {
    type CmuxLivePane,
    type CmuxLiveSnapshot,
    type CmuxPaneFrame,
    fetchCmuxLiveSnapshot,
} from "@genesiscz/utils/cmux/lib/live-snapshot";
import { buildCmuxHierarchy } from "@genesiscz/utils/cmux/lib/tree";
import {
    activeTreeBackoff,
    fileTreeBackoffStore,
    nextTreeBackoff,
    skippedTreeError,
    type TreeBackoffStore,
} from "@genesiscz/utils/cmux/lib/tree-backoff";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

/**
 * The live cmux hierarchy (window → workspace → pane → surface) with each pane's rectangle, and no
 * agent concepts. `tools cmux tree` prints it; `agent-tree.ts` layers session ids on top for
 * `tools ai cmux tree` and `tools claude cmux tree`.
 */
export interface CmuxTreeSurface {
    /** The surface UUID, stable across a relaunch; what the session journal records. */
    id: string;
    /** The `surface:N` ref, for display; cmux renumbers it at every relaunch. */
    ref?: string;
    title: string;
    type: string;
    index: number;
    selected: boolean;
    active: boolean;
}

export interface CmuxTreePane<S extends CmuxTreeSurface = CmuxTreeSurface> {
    /** Pane UUID. */
    id: string;
    /** `pane:N`, for display. */
    ref?: string;
    title: string;
    active: boolean;
    cwd?: string;
    /** UUID of the surface the pane shows. */
    selectedSurfaceId?: string;
    /** Pane rectangle inside the workspace, in points; with `container`, the real split layout. */
    frame?: CmuxPaneFrame;
    container?: { width: number; height: number };
    surfaces: S[];
}

export interface CmuxTreeWorkspace<S extends CmuxTreeSurface = CmuxTreeSurface> {
    /** Workspace UUID. */
    id: string;
    /** `workspace:N`, for display. */
    ref?: string;
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
    /**
     * The shared memory of a cmux that does not answer (`lib/tree-backoff.ts`); null turns it off. Default: the file
     * under `~/.genesis-tools/cmux/`, unless a snapshot is injected (a test), which gets none.
     */
    backoff?: TreeBackoffStore | null;
    /** The running cmux app's pid; default `findCmuxAppPid`. */
    appPid?: () => number | undefined;
    now?: () => number;
}

const prof = profiler.scope("cmux");
const { log } = logger.scoped("cmux-tree");

function toTreePane(pane: CmuxLivePane): CmuxTreePane {
    return {
        id: pane.id,
        ...(pane.ref ? { ref: pane.ref } : {}),
        title: pane.title,
        active: pane.active,
        cwd: pane.cwd,
        frame: pane.frame,
        container: pane.container,
        selectedSurfaceId: pane.selectedSurfaceId,
        surfaces: pane.surfaces.map((surface) => ({
            id: surface.id,
            ...(surface.ref ? { ref: surface.ref } : {}),
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
    const now = deps.now ?? Date.now;
    const backoff = deps.backoff !== undefined ? deps.backoff : deps.fetchSnapshot ? null : fileTreeBackoffStore();
    const previous = backoff?.read() ?? null;
    const skip = activeTreeBackoff({ record: previous, now: now(), appPid: deps.appPid ?? findCmuxAppPid });

    if (skip) {
        log.debug({ backoff: skip }, "cmux tree not asked: cmux did not answer recently");
        return {
            fetchedAt: new Date(now()).toISOString(),
            available: false,
            error: skippedTreeError(skip),
            windows: [],
            totalMs: performance.now() - started,
        };
    }

    const fetchSnapshot = deps.fetchSnapshot ?? (() => fetchCmuxLiveSnapshot({ previews: "none", allWindows: true }));
    const snapshot = await prof.measureAsync("tree.snapshot", fetchSnapshot);

    if (backoff) {
        const next = nextTreeBackoff({
            previous,
            unresponsive: snapshot.available ? undefined : snapshot.unresponsive,
            error: snapshot.error,
            now: now(),
        });

        // A success after no failure writes nothing, so a healthy cmux costs one stat per call.
        if (next || (previous && previous.failures > 0)) {
            backoff.write(next);
            log.debug({ backoff: next }, next ? "cmux tree backs off" : "cmux tree answered again; backoff cleared");
        }
    }

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
        workspaces: window.workspaces.map((ws) => ({
            id: ws.id,
            ...(ws.ref ? { ref: ws.ref } : {}),
            name: ws.name,
            panes: ws.panes.map(toTreePane),
        })),
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

import { runCmux, runCmuxJSON } from "@app/cmux/lib/cli";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { captureSurfaceState, cwdFromTitle } from "@app/cmux/lib/shell-probe";
import {
    browserUrl,
    paneList,
    type WindowEntry,
    type WorkspaceEntry,
    windowList,
    workspaceList,
} from "@app/cmux/lib/socket";
import type { Pane, Profile, ProfileScope, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import logger from "@app/logger";

interface SurfaceListEntry {
    ref: string;
    type: "terminal" | "browser";
    title?: string;
    /** Position within the parent pane (0..N-1). Field name is `index` in the CLI's list-pane-surfaces output. */
    index: number;
    /** True when this surface is the active tab of its pane. CLI calls this `selected`. */
    selected?: boolean;
}

interface ListPaneSurfacesResponse {
    surfaces: SurfaceListEntry[];
    pane_ref?: string;
    workspace_ref?: string;
    window_ref?: string;
}

export interface SnapshotOptions {
    name: string;
    scope: ProfileScope;
    targetWindowRef?: string;
    targetWorkspaceRef?: string;
    captureCwd: boolean;
    captureScreen: boolean;
    captureHistory: boolean;
    note?: string;
    cmuxVersion: string;
}

export interface SnapshotProgress {
    onWorkspaceStart?: (info: { ref: string; title: string; index: number; total: number }) => void;
    onWorkspaceDone?: (info: { ref: string; title: string }) => void;
}

interface CollectedWorkspace extends WorkspaceEntry {
    window_ref: string;
}

export async function captureProfile(options: SnapshotOptions, progress: SnapshotProgress = {}): Promise<Profile> {
    const allWindows = await windowList();
    const allWorkspaces = await collectAllWorkspaces(allWindows);

    const ctx = await getIdentifyContext();
    const targetWorkspaces = filterWorkspaces(allWorkspaces, options, ctx.focusedWorkspaceRef);
    const targetWindowRefs = new Set(targetWorkspaces.map((ws) => ws.window_ref));
    const targetWindows = allWindows.filter((w) => targetWindowRefs.has(w.ref));

    const windowsOut: Window[] = [];
    let visited = 0;
    for (const window of targetWindows) {
        const wsForWindow = targetWorkspaces
            .filter((ws) => ws.window_ref === window.ref)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        const workspacesOut: Workspace[] = [];
        let containerFrame = { width: 0, height: 0 };

        for (const ws of wsForWindow) {
            visited += 1;
            const title = ws.title ?? ws.ref;
            progress.onWorkspaceStart?.({
                ref: ws.ref,
                title,
                index: visited,
                total: targetWorkspaces.length,
            });

            const captured = await withFocusedWorkspace(ws.ref, async () => {
                const panes = await capturePanes(ws.ref, options, ctx.callerSurfaceRef);
                const fresh = await paneList(ws.ref);
                return { panes, container: fresh.container_frame };
            });

            if (captured.container.width > 0 && captured.container.height > 0) {
                containerFrame = captured.container;
            }

            workspacesOut.push({
                ref: ws.ref,
                title,
                selected: ws.selected ?? false,
                current_directory: ws.current_directory,
                panes: captured.panes,
            });

            progress.onWorkspaceDone?.({ ref: ws.ref, title });
        }

        windowsOut.push({
            ref: window.ref,
            title: `Window ${window.index + 1}`,
            container_frame: containerFrame,
            workspaces: workspacesOut,
        });
    }

    return {
        version: PROFILE_VERSION,
        name: options.name,
        scope: options.scope,
        captured_at: new Date().toISOString(),
        cmux_version: options.cmuxVersion,
        note: options.note,
        windows: windowsOut,
    };
}

async function collectAllWorkspaces(windows: WindowEntry[]): Promise<CollectedWorkspace[]> {
    const out: CollectedWorkspace[] = [];
    for (const window of windows) {
        const list = await workspaceList(window.ref);
        for (const ws of list.workspaces) {
            out.push({ ...ws, window_ref: window.ref });
        }
    }
    return out;
}

interface IdentifyContext {
    focusedWorkspaceRef?: string;
    /**
     * Surface where the save command itself is running. Capturing its visible screen
     * would record `tools cmux profiles save` as the bottom-of-screen content, which
     * then gets replayed verbatim into the restored pane — meta-circular and useless.
     * We skip screen capture for this one surface.
     */
    callerSurfaceRef?: string;
}

async function getIdentifyContext(): Promise<IdentifyContext> {
    try {
        const identify = await runCmuxJSON<{
            focused?: { workspace_ref?: string };
            caller?: { surface_ref?: string };
        }>(["identify"]);
        return {
            focusedWorkspaceRef: identify.focused?.workspace_ref,
            callerSurfaceRef: identify.caller?.surface_ref,
        };
    } catch {
        return {};
    }
}

function filterWorkspaces(
    all: CollectedWorkspace[],
    options: SnapshotOptions,
    focusedWorkspaceRef: string | undefined
): CollectedWorkspace[] {
    if (options.scope === "all") {
        return all;
    }
    if (options.scope === "window") {
        const focusedWindowRef = focusedWorkspaceRef
            ? all.find((ws) => ws.ref === focusedWorkspaceRef)?.window_ref
            : undefined;
        const ref = options.targetWindowRef ?? focusedWindowRef ?? all[0]?.window_ref;
        if (!ref) {
            throw new Error("scope=window requires a focused workspace or --window <ref>");
        }
        const filtered = all.filter((ws) => ws.window_ref === ref);
        if (filtered.length === 0 && options.targetWindowRef) {
            throw new Error(`No window matches --window ${options.targetWindowRef}`);
        }
        return filtered;
    }
    const ref = options.targetWorkspaceRef ?? focusedWorkspaceRef ?? all.find((ws) => ws.selected)?.ref;
    if (!ref) {
        throw new Error("scope=workspace requires a focused workspace or --workspace <ref>");
    }
    const filtered = all.filter((ws) => ws.ref === ref);
    if (filtered.length === 0 && options.targetWorkspaceRef) {
        throw new Error(`No workspace matches --workspace ${options.targetWorkspaceRef}`);
    }
    return filtered;
}

async function capturePanes(
    workspaceRef: string,
    options: SnapshotOptions,
    callerSurfaceRef: string | undefined
): Promise<Pane[]> {
    const layout = await paneList(workspaceRef);
    const panes: Pane[] = [];

    for (const paneInfo of layout.panes) {
        const surfacesInfo = await runCmuxJSON<ListPaneSurfacesResponse>([
            "list-pane-surfaces",
            "--workspace",
            workspaceRef,
            "--pane",
            paneInfo.ref,
        ]);

        const sortedEntries = [...surfacesInfo.surfaces].sort((a, b) => a.index - b.index);
        const surfaces: Surface[] = [];
        let selectedIndex = 0;
        for (const surfaceEntry of sortedEntries) {
            if (surfaceEntry.selected) {
                selectedIndex = surfaces.length;
            }
            surfaces.push(await captureSurface(surfaceEntry, workspaceRef, options, callerSurfaceRef));
        }

        panes.push({
            ref: paneInfo.ref,
            index: paneInfo.index,
            columns: paneInfo.columns,
            rows: paneInfo.rows,
            pixel_frame: paneInfo.pixel_frame,
            selected_surface_index: selectedIndex,
            surfaces,
        });
    }

    return panes;
}

async function captureSurface(
    entry: SurfaceListEntry,
    workspaceRef: string,
    options: SnapshotOptions,
    callerSurfaceRef: string | undefined
): Promise<Surface> {
    const title = entry.title ?? "";
    if (entry.type === "browser") {
        const url = await browserUrl(entry.ref);
        return { type: "browser", title, url: url ?? undefined };
    }

    const cwd = options.captureCwd ? cwdFromTitle(title) : undefined;
    // Skip screen capture for the surface running this very save command — its
    // visible content is dominated by the `tools cmux profiles save` invocation
    // and the running clack prompts, which would replay back into the restored
    // pane verbatim. Other panes still get full screen capture.
    const isCaller = callerSurfaceRef !== undefined && entry.ref === callerSurfaceRef;
    if (isCaller && options.captureScreen) {
        logger.debug({ surfaceRef: entry.ref }, "[snapshot] skipping screen capture for caller surface");
    }
    const captured = await captureSurfaceState(workspaceRef, entry.ref, {
        screen: options.captureScreen && !isCaller,
        history: options.captureHistory,
    });

    return {
        type: "terminal",
        title,
        cwd,
        screen: captured.screen,
        command: captured.command.value,
        command_source: captured.command.value ? captured.command.source : undefined,
    };
}

export async function getCmuxVersion(): Promise<string> {
    try {
        const result = await runCmux(["--version"]);
        const match = result.stdout.match(/cmux (\S+)/);
        if (match) {
            return match[1];
        }
    } catch (error) {
        logger.debug({ error }, "[snapshot] cmux version unavailable");
    }
    return "unknown";
}

import { runCmux, runCmuxJSON } from "@app/cmux/lib/cli";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { cwdFromTitle, lastHistoryHint } from "@app/cmux/lib/shell-probe";
import {
    browserUrl,
    paneList,
    type WindowEntry,
    type WorkspaceEntry,
    windowList,
    workspaceList,
} from "@app/cmux/lib/socket";
import type { CommandSource, Pane, Profile, ProfileScope, Surface, Window, Workspace } from "@app/cmux/lib/types";
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

type ListPaneSurfacesResponse = SurfaceListEntry[];

export interface SnapshotOptions {
    name: string;
    scope: ProfileScope;
    targetWindowRef?: string;
    targetWorkspaceRef?: string;
    captureCwd: boolean;
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

    const focusedRef = await getFocusedWorkspaceRef();
    const targetWorkspaces = filterWorkspaces(allWorkspaces, options, focusedRef);
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
                const panes = await capturePanes(ws.ref, options);
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

async function getFocusedWorkspaceRef(): Promise<string | undefined> {
    try {
        const identify = await runCmuxJSON<{ focused?: { workspace_ref?: string } }>(["identify"]);
        return identify.focused?.workspace_ref;
    } catch {
        return undefined;
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
        return all.filter((ws) => ws.window_ref === ref);
    }
    const ref = options.targetWorkspaceRef ?? focusedWorkspaceRef ?? all.find((ws) => ws.selected)?.ref;
    if (!ref) {
        throw new Error("scope=workspace requires a focused workspace or --workspace <ref>");
    }
    return all.filter((ws) => ws.ref === ref);
}

async function capturePanes(workspaceRef: string, options: SnapshotOptions): Promise<Pane[]> {
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

        const sortedEntries = [...surfacesInfo].sort((a, b) => a.index - b.index);
        const surfaces: Surface[] = [];
        let selectedIndex = 0;
        for (const surfaceEntry of sortedEntries) {
            if (surfaceEntry.selected) {
                selectedIndex = surfaces.length;
            }
            surfaces.push(await captureSurface(surfaceEntry, options));
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

async function captureSurface(entry: SurfaceListEntry, options: SnapshotOptions): Promise<Surface> {
    const title = entry.title ?? "";
    if (entry.type === "browser") {
        const url = await browserUrl(entry.ref);
        return { type: "browser", title, url: url ?? undefined };
    }

    const cwd = options.captureCwd ? cwdFromTitle(title) : undefined;
    let command: string | undefined;
    let commandSource: CommandSource = "none";
    if (options.captureHistory) {
        const hint = lastHistoryHint();
        command = hint.value;
        commandSource = hint.source;
    }

    return {
        type: "terminal",
        title,
        cwd,
        command,
        command_source: commandSource,
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

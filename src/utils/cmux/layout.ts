import { runCmuxJSON } from "@app/cmux/lib/cli";
import { redactTerminalPreview } from "@app/cmux/lib/live-snapshot";
import { rpc, windowList, type WorkspaceEntry } from "@app/cmux/lib/socket";
import { logger } from "@app/logger";
import type {
    CmuxLayoutPane,
    CmuxLayoutSurface,
    CmuxLayoutTree,
    CmuxLayoutWindow,
    CmuxLayoutWorkspace,
} from "@app/utils/cmux/types";

interface PaneListRpc {
    panes?: PaneRpc[];
}

interface PaneRpc {
    ref?: string;
    id?: string;
    title?: string;
    selected?: boolean;
    focused?: boolean;
    selected_surface_ref?: string;
}

interface SurfaceListRpc {
    surfaces?: SurfaceRpc[];
}

interface SurfaceRpc {
    ref?: string;
    id?: string;
    title?: string;
    type?: string;
    selected?: boolean;
    selected_in_pane?: boolean;
}

function paneRef(pane: PaneRpc): string {
    return pane.ref ?? pane.id ?? "pane:unknown";
}

function paneTitle(pane: PaneRpc): string {
    return pane.title ?? paneRef(pane);
}

function surfaceRef(surface: SurfaceRpc): string {
    return surface.ref ?? surface.id ?? "surface:unknown";
}

function surfaceTitle(surface: SurfaceRpc): string {
    return surface.title ?? surfaceRef(surface);
}

function workspaceName(workspace: WorkspaceEntry): string {
    return workspace.title ?? workspace.id ?? workspace.ref;
}

async function readSelectedSurfacePreview(workspaceId: string, surfaceId: string): Promise<string | undefined> {
    try {
        const { runCmux } = await import("@app/cmux/lib/cli");
        const response = await runCmux(["capture-pane", "--workspace", workspaceId, "--surface", surfaceId, "--lines", "80"]);

        if (response.code !== 0) {
            return undefined;
        }

        return redactTerminalPreview(response.stdout);
    } catch (err) {
        logger.debug({ err, workspaceId, surfaceId }, "cmux layout preview failed");
        return undefined;
    }
}

async function fetchWorkspacePanes(workspace: WorkspaceEntry): Promise<CmuxLayoutPane[]> {
    const workspaceId = workspace.ref;
    const paneResponse = await runCmuxJSON<PaneListRpc>(["list-panes", "--workspace", workspaceId]);
    const panes: CmuxLayoutPane[] = [];

    for (const pane of paneResponse.panes ?? []) {
        const paneId = paneRef(pane);
        const surfaceResponse = await runCmuxJSON<SurfaceListRpc>([
            "list-pane-surfaces",
            "--workspace",
            workspaceId,
            "--pane",
            paneId,
        ]);
        const rawSurfaces = surfaceResponse.surfaces ?? [];
        const surfaces: CmuxLayoutSurface[] = await Promise.all(
            rawSurfaces.map(async (surface) => {
                const id = surfaceRef(surface);
                const selected = surface.selected_in_pane === true || surface.selected === true;
                const preview = selected ? await readSelectedSurfacePreview(workspaceId, id) : undefined;

                return {
                    id,
                    title: surfaceTitle(surface),
                    type: surface.type ?? "terminal",
                    selected,
                    preview,
                };
            })
        );

        panes.push({
            id: paneId,
            title: paneTitle(pane),
            active: pane.selected === true || pane.focused === true,
            surfaces,
        });
    }

    return panes;
}

export async function fetchCmuxFullLayout(): Promise<CmuxLayoutTree> {
    const fetchedAt = new Date().toISOString();

    try {
        const windows = await windowList();
        const layoutWindows: CmuxLayoutWindow[] = [];

        for (const window of windows) {
            const wsResponse = await rpc<{
                workspaces?: WorkspaceEntry[];
            }>("workspace.list", { window: window.ref });
            const workspaces: CmuxLayoutWorkspace[] = [];

            for (const workspace of wsResponse.workspaces ?? []) {
                const panes = await fetchWorkspacePanes(workspace);
                workspaces.push({
                    id: workspace.ref,
                    name: workspaceName(workspace),
                    selected: workspace.selected,
                    panes,
                });
            }

            layoutWindows.push({
                id: window.ref,
                index: window.index,
                visible: window.visible,
                workspaces,
            });
        }

        return { fetchedAt, available: true, windows: layoutWindows };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "cmux full layout failed");

        return { fetchedAt, available: false, error: message, windows: [] };
    }
}

export async function findWorkspaceByName(name: string): Promise<{ workspaceId: string; windowId: string } | null> {
    const layout = await fetchCmuxFullLayout();

    for (const window of layout.windows) {
        for (const workspace of window.workspaces) {
            if (workspace.name === name) {
                return { workspaceId: workspace.id, windowId: window.id };
            }
        }
    }

    return null;
}

export async function listAllWorkspaces(): Promise<Array<{ id: string; name: string; windowId: string }>> {
    const layout = await fetchCmuxFullLayout();

    return layout.windows.flatMap((window) =>
        window.workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            windowId: window.id,
        }))
    );
}

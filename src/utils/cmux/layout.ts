import { runCmuxJSON } from "@app/cmux/lib/cli";
import { redactTerminalPreview } from "@app/cmux/lib/live-snapshot";
import { rpc, type WorkspaceEntry, windowList } from "@app/cmux/lib/socket";
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

const PREVIEW_LINE_BUDGET = 100;
const PREVIEW_HEAD_LINES = 24;

export function formatDualPreview(text: string, maxLines = PREVIEW_LINE_BUDGET): string {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const safeMaxLines = Math.max(1, maxLines);

    if (lines.length <= safeMaxLines) {
        return lines.join("\n");
    }

    if (safeMaxLines <= 2) {
        return lines.slice(0, safeMaxLines).join("\n");
    }

    const headLines = Math.min(PREVIEW_HEAD_LINES, safeMaxLines - 2);
    const tailLines = safeMaxLines - headLines - 1;
    const omitted = lines.length - headLines - tailLines;

    return [...lines.slice(0, headLines), `── ··· ${omitted} lines ··· ──`, ...lines.slice(-tailLines)].join("\n");
}

async function readSelectedSurfacePreview(workspaceId: string, surfaceId: string): Promise<string | undefined> {
    try {
        const { runCmux } = await import("@app/cmux/lib/cli");
        const response = await runCmux([
            "capture-pane",
            "--workspace",
            workspaceId,
            "--surface",
            surfaceId,
            "--lines",
            String(PREVIEW_LINE_BUDGET),
        ]);

        if (response.code !== 0) {
            return undefined;
        }

        return formatDualPreview(redactTerminalPreview(response.stdout));
    } catch (error) {
        logger.debug({ error, workspaceId, surfaceId }, "cmux layout preview failed");
        return undefined;
    }
}

export interface FetchCmuxLayoutOptions {
    /**
     * When false (default true), skip the per-selected-surface `capture-pane` call —
     * each preview spawns a cmux child and grabs hundreds of lines of terminal text.
     * Callers that only need surface/pane/workspace metadata (e.g. tmux-hub session
     * enrichment in /api/tmux/sessions, which discards `preview`) should pass false.
     * Cuts a 12-workspace layout fetch from ~700ms to ~150ms.
     */
    includePreviews?: boolean;
}

async function fetchWorkspacePanes(
    workspace: WorkspaceEntry,
    options: FetchCmuxLayoutOptions
): Promise<CmuxLayoutPane[]> {
    const workspaceId = workspace.ref;
    const paneResponse = await runCmuxJSON<PaneListRpc>(["list-panes", "--workspace", workspaceId]);
    const includePreviews = options.includePreviews !== false;

    return Promise.all(
        (paneResponse.panes ?? []).map(async (pane) => {
            const paneId = paneRef(pane);
            const surfaceResponse = await runCmuxJSON<SurfaceListRpc>([
                "list-pane-surfaces",
                "--workspace",
                workspaceId,
                "--pane",
                paneId,
            ]);
            const surfaces: CmuxLayoutSurface[] = await Promise.all(
                (surfaceResponse.surfaces ?? []).map(async (surface) => {
                    const id = surfaceRef(surface);
                    const selected = surface.selected_in_pane === true || surface.selected === true;
                    const preview =
                        selected && includePreviews ? await readSelectedSurfacePreview(workspaceId, id) : undefined;

                    return {
                        id,
                        title: surfaceTitle(surface),
                        type: surface.type ?? "terminal",
                        selected,
                        preview,
                    };
                })
            );

            return {
                id: paneId,
                title: paneTitle(pane),
                active: pane.selected === true || pane.focused === true,
                surfaces,
            };
        })
    );
}

export async function fetchCmuxFullLayout(options: FetchCmuxLayoutOptions = {}): Promise<CmuxLayoutTree> {
    const fetchedAt = new Date().toISOString();

    try {
        const windows = await windowList();

        const layoutWindows: CmuxLayoutWindow[] = await Promise.all(
            windows.map(async (window) => {
                const wsResponse = await rpc<{
                    workspaces?: WorkspaceEntry[];
                }>("workspace.list", { window: window.ref });

                const workspaces: CmuxLayoutWorkspace[] = await Promise.all(
                    (wsResponse.workspaces ?? []).map(async (workspace) => ({
                        id: workspace.ref,
                        name: workspaceName(workspace),
                        selected: workspace.selected,
                        panes: await fetchWorkspacePanes(workspace, options),
                    }))
                );

                return {
                    id: window.ref,
                    index: window.index,
                    visible: window.visible,
                    workspaces,
                };
            })
        );

        return { fetchedAt, available: true, windows: layoutWindows };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug({ error }, "cmux full layout failed");

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

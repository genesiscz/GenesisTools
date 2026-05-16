import { type CmuxRunResult, runCmux, runCmuxJSON } from "@app/cmux/lib/cli";
import logger from "@app/logger";

export interface CmuxLiveWorkspace {
    id: string;
    name: string;
}

export interface CmuxLivePane {
    id: string;
    workspaceId: string;
    title: string;
    active: boolean;
    cwd?: string;
    selectedSurfaceRef?: string;
    surfaceCount: number;
    surfaces: CmuxLiveSurface[];
    preview?: string;
}

export interface CmuxLiveSurface {
    id: string;
    title: string;
    type: string;
    index: number;
    selected: boolean;
    active: boolean;
    preview?: string;
    url?: string;
}

export interface CmuxLiveSnapshot {
    fetchedAt: string;
    available: boolean;
    error?: string;
    workspaces: CmuxLiveWorkspace[];
    panes: CmuxLivePane[];
}

type CmuxJsonRunner = <T>(args: string[]) => Promise<T>;
type CmuxRunner = (args: string[]) => Promise<CmuxRunResult>;

interface WorkspaceListRpc {
    workspaces?: WorkspaceRpc[];
}

interface WorkspaceRpc {
    id?: string;
    ref?: string;
    name?: string;
    title?: string;
    current_directory?: string;
}

interface PaneListRpc {
    panes?: PaneRpc[];
}

interface PaneRpc {
    id?: string;
    ref?: string;
    workspace?: string;
    index?: number;
    title?: string;
    selected?: boolean;
    focused?: boolean;
    cwd?: string;
    selected_surface_ref?: string;
    surface_count?: number;
    surface_refs?: string[];
}

interface SurfaceListRpc {
    surfaces?: SurfaceRpc[];
}

interface SurfaceRpc {
    id?: string;
    ref?: string;
    index?: number;
    index_in_pane?: number;
    title?: string;
    type?: string;
    selected?: boolean;
    selected_in_pane?: boolean;
    active?: boolean;
    focused?: boolean;
    url?: string;
}

interface SnapshotDeps {
    runJson?: CmuxJsonRunner;
    run?: CmuxRunner;
}

const SECRET_LINE_PATTERNS: RegExp[] = [
    /^(\s*password\s*:\s*).+$/gim,
    /^(\s*CLOUDFLARE_API_TOKEN\s*=\s*).+$/gim,
    /^(\s*Authorization:\s*Basic\s+).+$/gim,
    /((?:https?:\/\/)[^:\s/]+:)[^@\s/]+@/gim,
];

export function redactTerminalPreview(preview: string): string {
    const redactedLines = SECRET_LINE_PATTERNS.reduce(
        (redacted, pattern) => redacted.replace(pattern, (_match, prefix: string) => `${prefix}[redacted]`),
        preview
    );

    return redactedLines.replace(
        /(-u\s+)(['"]?)([^:'"\s]+:)[^'"\s]+(\2)/gim,
        (_match, flag: string, quote: string, username: string, closingQuote: string) =>
            `${flag}${quote}${username}[redacted]${closingQuote}`
    );
}

function workspaceId(workspace: WorkspaceRpc): string {
    return workspace.ref ?? workspace.id ?? "workspace:unknown";
}

function workspaceName(workspace: WorkspaceRpc): string {
    return workspace.title ?? workspace.name ?? workspace.id ?? workspace.ref ?? "workspace";
}

function paneId(pane: PaneRpc): string {
    return pane.ref ?? pane.id ?? "pane:unknown";
}

function paneTitle(pane: PaneRpc): string {
    return pane.title ?? paneId(pane);
}

function surfaceId(surface: SurfaceRpc): string {
    return surface.ref ?? surface.id ?? "surface:unknown";
}

function surfaceTitle(surface: SurfaceRpc): string {
    return surface.title ?? surfaceId(surface);
}

async function readSurfacePreview({
    run,
    workspace,
    surface,
}: {
    run: CmuxRunner;
    workspace: string;
    surface?: string;
}): Promise<string | undefined> {
    if (!surface) {
        return undefined;
    }

    try {
        const response = await run(["capture-pane", "--workspace", workspace, "--surface", surface, "--lines", "40"]);

        if (response.code !== 0) {
            logger.debug({ workspace, surface, stderr: response.stderr.trim() }, "cmux surface preview failed");
            return undefined;
        }

        return redactTerminalPreview(response.stdout);
    } catch (err) {
        logger.debug({ err, workspace, surface }, "cmux surface preview failed");
        return undefined;
    }
}

export async function fetchCmuxLiveSnapshot(deps: SnapshotDeps = {}): Promise<CmuxLiveSnapshot> {
    const runJson = deps.runJson ?? runCmuxJSON;
    const run = deps.run ?? runCmux;
    const fetchedAt = new Date().toISOString();

    try {
        const workspaceResponse = await runJson<WorkspaceListRpc>(["list-workspaces"]);
        const rawWorkspaces = workspaceResponse.workspaces ?? [];
        const workspaces: CmuxLiveWorkspace[] = rawWorkspaces.map((workspace) => ({
            id: workspaceId(workspace),
            name: workspaceName(workspace),
        }));
        const panes: CmuxLivePane[] = [];

        for (const rawWorkspace of rawWorkspaces) {
            const id = workspaceId(rawWorkspace);
            const paneResponse = await runJson<PaneListRpc>(["list-panes", "--workspace", id]);

            for (const pane of paneResponse.panes ?? []) {
                const selectedSurfaceRef = pane.selected_surface_ref;
                const surfaceResponse = await runJson<SurfaceListRpc>([
                    "list-pane-surfaces",
                    "--workspace",
                    id,
                    "--pane",
                    paneId(pane),
                ]);
                const surfaces: CmuxLiveSurface[] = [];

                for (const surface of surfaceResponse.surfaces ?? []) {
                    const surfaceRef = surfaceId(surface);
                    surfaces.push({
                        id: surfaceRef,
                        title: surfaceTitle(surface),
                        type: surface.type ?? "terminal",
                        index: surface.index_in_pane ?? surface.index ?? surfaces.length,
                        selected: surface.selected_in_pane === true || surface.selected === true,
                        active: surface.focused === true || surface.active === true,
                        url: surface.url,
                        preview: await readSurfacePreview({ run, workspace: id, surface: surfaceRef }),
                    });
                }

                const selectedSurface = surfaces.find((surface) => surface.selected) ?? surfaces[0];
                panes.push({
                    id: paneId(pane),
                    workspaceId: pane.workspace ?? id,
                    title: paneTitle(pane),
                    active: pane.selected === true || pane.focused === true,
                    cwd: pane.cwd ?? rawWorkspace.current_directory,
                    selectedSurfaceRef,
                    surfaceCount: pane.surface_count ?? surfaces.length,
                    surfaces,
                    preview: selectedSurface?.preview,
                });
            }
        }

        return { fetchedAt, available: true, workspaces, panes };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "cmux live snapshot failed");

        return { fetchedAt, available: false, error: message, workspaces: [], panes: [] };
    }
}

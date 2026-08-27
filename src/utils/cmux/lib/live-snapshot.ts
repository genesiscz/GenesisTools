import { type CmuxRunResult, runCmux, runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { ensureCmuxResponsive } from "@genesiscz/utils/cmux/lib/health";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

export interface CmuxLiveWorkspace {
    id: string;
    name: string;
    /** Owning cmux window ref (e.g. `window:1`), when the listing was window-scoped. */
    windowRef?: string;
}

export interface CmuxLiveWindow {
    id: string;
    /** `window:N` ref as other RPCs report it, when resolvable. */
    ref?: string;
    index: number;
    /** True for the key (frontmost) window. */
    key: boolean;
    workspaceCount: number;
}

export interface CmuxLivePane {
    id: string;
    workspaceId: string;
    title: string;
    active: boolean;
    cwd?: string;
    /** Owning cmux window, from `pane.list`. Lets focus skip a second `identify`. */
    windowRef?: string;
    selectedSurfaceRef?: string;
    surfaceCount: number;
    surfaces: CmuxLiveSurface[];
    preview?: string;
    /**
     * The ttyd session id this pane's terminal surface is backed by, when the pane hosts a tmux
     * session that also has a ttyd terminal (joined by tmux session name). Lets a client open the
     * pane as a real terminal instead of only focusing it in the native cmux app. Populated by the
     * dev-dashboard layer (`enrichPanesWithTtyd`) — this generic module stays ttyd-agnostic, so it is
     * always undefined here and set downstream.
     */
    ttydSessionId?: string;
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
    /** Populated in `allWindows` mode; the default snapshot covers only the key window. */
    windows?: CmuxLiveWindow[];
    workspaces: CmuxLiveWorkspace[];
    panes: CmuxLivePane[];
}

type CmuxJsonRunner = <T>(args: string[]) => Promise<T>;
type CmuxRunner = (args: string[]) => Promise<CmuxRunResult>;

interface WorkspaceListRpc {
    workspaces?: WorkspaceRpc[];
    window_ref?: string;
}

interface WindowRpc {
    id?: string;
    index?: number;
    key?: boolean;
    workspace_count?: number;
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
    window_ref?: string;
    workspace_ref?: string;
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

export type SnapshotPreviewMode = "all" | "selected" | "none";

interface SnapshotDeps {
    runJson?: CmuxJsonRunner;
    run?: CmuxRunner;
    /** `all` (default) captures every surface. `selected` is the focus-command fast path. */
    previews?: SnapshotPreviewMode;
    /**
     * Enumerate every cmux window (`list-windows` + `list-workspaces --window`).
     * Default false: one `list-workspaces` call, which covers only the key window.
     */
    allWindows?: boolean;
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
        const response = await run(["capture-pane", "--workspace", workspace, "--surface", surface, "--lines", "200"]);

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

function shouldCapturePreview(previews: SnapshotPreviewMode, selected: boolean): boolean {
    if (previews === "none") {
        return false;
    }

    if (previews === "selected") {
        return selected;
    }

    return true;
}

async function fetchOnePane({
    pane,
    workspaceId: id,
    windowRef,
    rawWorkspace,
    runJson,
    run,
    previews,
}: {
    pane: PaneRpc;
    workspaceId: string;
    windowRef?: string;
    rawWorkspace: WorkspaceRpc;
    runJson: CmuxJsonRunner;
    run: CmuxRunner;
    previews: SnapshotPreviewMode;
}): Promise<CmuxLivePane> {
    const selectedSurfaceRef = pane.selected_surface_ref;
    const surfaceResponse = await runJson<SurfaceListRpc>([
        "list-pane-surfaces",
        "--workspace",
        id,
        "--pane",
        paneId(pane),
    ]);
    const rawSurfaces = surfaceResponse.surfaces ?? [];
    const anyMarkedSelected = rawSurfaces.some(
        (surface) => surface.selected_in_pane === true || surface.selected === true
    );
    const surfaces: CmuxLiveSurface[] = await Promise.all(
        rawSurfaces.map(async (surface, index) => {
            const surfaceRef = surfaceId(surface);
            const selected =
                surface.selected_in_pane === true || surface.selected === true || (!anyMarkedSelected && index === 0);

            return {
                id: surfaceRef,
                title: surfaceTitle(surface),
                type: surface.type ?? "terminal",
                index: surface.index_in_pane ?? surface.index ?? index,
                selected,
                active: surface.focused === true || surface.active === true,
                url: surface.url,
                preview: shouldCapturePreview(previews, selected)
                    ? await readSurfacePreview({ run, workspace: id, surface: surfaceRef })
                    : undefined,
            };
        })
    );

    const selectedSurface = surfaces.find((surface) => surface.selected) ?? surfaces[0];

    return {
        id: paneId(pane),
        workspaceId: pane.workspace ?? id,
        title: paneTitle(pane),
        active: pane.selected === true || pane.focused === true,
        cwd: pane.cwd ?? rawWorkspace.current_directory,
        windowRef,
        selectedSurfaceRef: selectedSurfaceRef ?? selectedSurface?.id,
        surfaceCount: pane.surface_count ?? surfaces.length,
        surfaces,
        preview: selectedSurface?.preview,
    };
}

async function fetchWorkspacePanes(
    rawWorkspace: WorkspaceRpc,
    runJson: CmuxJsonRunner,
    run: CmuxRunner,
    previews: SnapshotPreviewMode
): Promise<CmuxLivePane[]> {
    const id = workspaceId(rawWorkspace);
    const paneResponse = await runJson<PaneListRpc>(["list-panes", "--workspace", id]);
    const windowRef = paneResponse.window_ref;
    const rawPanes = paneResponse.panes ?? [];

    return Promise.all(
        rawPanes.map((pane) => fetchOnePane({ pane, workspaceId: id, windowRef, rawWorkspace, runJson, run, previews }))
    );
}

/** Test hook: parallel workspace fan-out with an injectable per-workspace runner. */
export async function fetchCmuxLiveSnapshotWithRunner<T>(
    workspaces: string[],
    fetchWorkspace: (ws: string, index: number) => Promise<T>
): Promise<T[]> {
    return Promise.all(workspaces.map((ws, index) => fetchWorkspace(ws, index)));
}

export async function fetchCmuxLiveSnapshot(deps: SnapshotDeps = {}): Promise<CmuxLiveSnapshot> {
    const runJson = deps.runJson ?? runCmuxJSON;
    const run = deps.run ?? runCmux;
    const previews = deps.previews ?? "all";
    const fetchedAt = new Date().toISOString();

    const prof = profiler.scope("cmux");
    try {
        // Fail fast on a starved UI thread: with a livelocked cmux every state command
        // below would hang for its full per-request timeout. Injected runners (tests)
        // skip the probe.
        if (!deps.runJson) {
            await prof.measureAsync("preflight", () => ensureCmuxResponsive("cmux live snapshot"));
        }

        let windows: CmuxLiveWindow[] | undefined;
        let workspaceLists: WorkspaceListRpc[];

        if (deps.allWindows) {
            const rawWindows = await prof.measureAsync("list-windows", () => runJson<WindowRpc[]>(["list-windows"]));
            workspaceLists = await prof.measureAsync("list-workspaces", () =>
                Promise.all(
                    rawWindows.map((w) =>
                        runJson<WorkspaceListRpc>(["list-workspaces", "--window", w.id ?? String(w.index ?? 0)])
                    )
                )
            );
            windows = rawWindows.map((w, i) => ({
                id: w.id ?? `window:${i}`,
                ref: workspaceLists[i]?.window_ref,
                index: w.index ?? i,
                key: w.key === true,
                workspaceCount: w.workspace_count ?? workspaceLists[i]?.workspaces?.length ?? 0,
            }));
        } else {
            workspaceLists = [
                await prof.measureAsync("list-workspaces", () => runJson<WorkspaceListRpc>(["list-workspaces"])),
            ];
        }

        const rawWorkspaces = workspaceLists.flatMap(
            (list) => list.workspaces?.map((workspace) => ({ workspace, windowRef: list.window_ref })) ?? []
        );
        const workspaces: CmuxLiveWorkspace[] = rawWorkspaces.map(({ workspace, windowRef }) => ({
            id: workspaceId(workspace),
            name: workspaceName(workspace),
            windowRef,
        }));

        const paneGroups = await prof.measureAsync("list-panes+surfaces", () =>
            Promise.all(rawWorkspaces.map(({ workspace }) => fetchWorkspacePanes(workspace, runJson, run, previews)))
        );
        const panes = paneGroups.flat();
        prof.summary(`snapshot previews=${previews}`);

        return { fetchedAt, available: true, windows, workspaces, panes };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ err: message }, "cmux live snapshot failed");

        return { fetchedAt, available: false, error: message, workspaces: [], panes: [] };
    }
}

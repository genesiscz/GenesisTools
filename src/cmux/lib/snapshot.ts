import {
    loadGrokCatalog,
    type ReplayCatalog,
    type ReplayCatalogSession,
    replayCommandForSurface,
} from "@app/cmux/lib/agent-replay";
import { panelsById, readAutosaveSession } from "@app/cmux/lib/autosave";
import { collectTtyLaunchCommands, loadSurfaceSessions, type SurfaceSessionInfo } from "@app/cmux/lib/command-capture";
import { captureSurfaceState, cwdFromTitle } from "@app/cmux/lib/shell-probe";
import type { Pane, Profile, ProfileScope, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { runCmux, runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import {
    browserUrl,
    type PaneListPane,
    paneList,
    type WindowEntry,
    type WorkspaceEntry,
    windowList,
    workspaceList,
} from "@genesiscz/utils/cmux/lib/socket";
import { logger } from "@genesiscz/utils/logger";

interface SurfaceListEntry {
    ref: string;
    /** Surface UUID (== CMUX_SURFACE_ID == autosave panel id); present with --id-format both. */
    id?: string;
    type: "terminal" | "browser";
    title?: string;
    /** Position within the parent pane (0..N-1). Field name is `index` in the CLI's list-pane-surfaces output. */
    index: number;
    /** True when this surface is the active tab of its pane. CLI calls this `selected`. */
    selected?: boolean;
}

/**
 * Joined side-channels for command capture: the process table (foreground command
 * per tty), cmux's autosave (surface uuid → tty), and the claude session journals
 * (surface uuid → session id + account). All readable without the cmux socket.
 */
interface CommandCaptureContext {
    ttyCommands: Map<string, string>;
    panelTty: Map<string, string>;
    surfaceSessions: Map<string, SurfaceSessionInfo>;
    replayCatalog: ReplayCatalog;
}

export async function buildCommandCaptureContext(): Promise<CommandCaptureContext> {
    const [ttyCommands, surfaceSessions] = await Promise.all([collectTtyLaunchCommands(), loadSurfaceSessions()]);

    const panelTty = new Map<string, string>();
    const grokCwds: string[] = [];
    try {
        const session = readAutosaveSession();
        for (const [id, panel] of panelsById(session)) {
            if (panel.ttyName) {
                panelTty.set(id, panel.ttyName);
            }
        }

        for (const window of session.windows) {
            for (const workspace of window.tabManager.workspaces) {
                if (workspace.currentDirectory) {
                    grokCwds.push(workspace.currentDirectory);
                }

                for (const panel of workspace.panels) {
                    if (panel.directory) {
                        grokCwds.push(panel.directory);
                    }
                }
            }
        }
    } catch (error) {
        logger.debug({ error }, "[snapshot] autosave unavailable — foreground command capture degraded");
    }

    return { ttyCommands, panelTty, surfaceSessions, replayCatalog: { sessions: loadGrokCatalog(grokCwds) } };
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
    const capture = options.captureHistory ? await buildCommandCaptureContext() : undefined;
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
                const panes = await capturePanes(ws.ref, options, ctx.callerSurfaceRef, capture);
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

/** The cell size any rendered pane reports; they all share one font. */
function cellSizeOf(panes: PaneListPane[], field: "cell_width_px" | "cell_height_px"): number | undefined {
    return panes.find((pane) => pane[field])?.[field];
}

async function capturePanes(
    workspaceRef: string,
    options: SnapshotOptions,
    callerSurfaceRef: string | undefined,
    capture: CommandCaptureContext | undefined
): Promise<Pane[]> {
    const layout = await paneList(workspaceRef);
    const panes: Pane[] = [];

    for (const paneInfo of layout.panes) {
        const surfacesInfo = await runCmuxJSON<ListPaneSurfacesResponse>([
            "--id-format",
            "both",
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
            surfaces.push(await captureSurface(surfaceEntry, workspaceRef, options, callerSurfaceRef, capture));
        }

        // A pane cmux has not rendered reports no cell geometry, only pixels. The saved
        // columns/rows are a convergence YARDSTICK for restore, so derive them from the
        // pixel frame rather than writing a hole into the profile.
        //
        // The cell size comes from a SIBLING pane, because all four cell fields go
        // missing together: reading `paneInfo.cell_width_px` here always finds nothing
        // and the hardcoded default would apply. On this display the real cell is
        // 16 x 34 px against defaults of 8 x 17, so the derived numbers came out ~2x
        // too large and restore then reported an exact layout as unconverged.
        const cellWidthPx = paneInfo.cell_width_px || cellSizeOf(layout.panes, "cell_width_px") || 8;
        const cellHeightPx = paneInfo.cell_height_px || cellSizeOf(layout.panes, "cell_height_px") || 17;
        const columns = paneInfo.columns ?? Math.round(paneInfo.pixel_frame.width / cellWidthPx);
        const rows = paneInfo.rows ?? Math.round(paneInfo.pixel_frame.height / cellHeightPx);

        if (paneInfo.columns === undefined || paneInfo.rows === undefined) {
            logger.debug(
                { pane: paneInfo.ref, columns, rows },
                "[snapshot] pane had no cell geometry — derived it from the pixel frame"
            );
        }

        panes.push({
            ref: paneInfo.ref,
            index: paneInfo.index,
            columns,
            rows,
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
    callerSurfaceRef: string | undefined,
    capture: CommandCaptureContext | undefined
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

    // The foreground process on the pane's tty beats scrollback parsing: a pane
    // running a fullscreen TUI (claude, grok, vim) shows no shell prompt to parse,
    // but its launch command is right there in the process table.
    const tty = capture && entry.id ? capture.panelTty.get(entry.id) : undefined;
    const foreground = tty ? capture?.ttyCommands.get(tty) : undefined;
    const original = foreground ?? captured.command.value;
    const session = capture && entry.id ? capture.surfaceSessions.get(entry.id) : undefined;
    // Always "claude": this id comes from the Claude cmux-refs journal and
    // nowhere else. Typing it from the tab title made any pane whose title ends
    // in the word "grok" (including a shell in a directory named grok) replay
    // `grok -r <claude uuid>`, a session grok has never seen.
    const preferred: ReplayCatalogSession | undefined = session
        ? {
              kind: "claude",
              sessionId: session.sessionId,
              cwd: cwd ?? "",
              title,
              account: session.account,
          }
        : undefined;
    const derived = replayCommandForSurface(
        { title, cwd, command: original },
        capture?.replayCatalog ?? { sessions: [] },
        preferred
    );
    if (!derived.command) {
        return { type: "terminal", title, cwd, screen: captured.screen };
    }

    return {
        type: "terminal",
        title,
        cwd,
        screen: captured.screen,
        command: derived.command,
        command_source: foreground ? "foreground" : derived.command !== original ? "inferred" : captured.command.source,
        command_original: derived.command !== original ? original : undefined,
        drift: derived.drift.length > 0 ? derived.drift : undefined,
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

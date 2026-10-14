import {
    loadGrokCatalog,
    type ReplayCatalog,
    type ReplayCatalogSession,
    replayCommandForSurface,
} from "@app/cmux/lib/agent-replay";
import { type AutosaveSession, panelsById, panelWorkingDirectory, readAutosaveSession } from "@app/cmux/lib/autosave";
import { type CapturedCommand, loadCapturedCommands } from "@app/cmux/lib/capture-journal";
import {
    collectTtyCapture,
    isAgentLauncher,
    journalReplayCommand,
    loadPinnedAccounts,
    loadSurfaceSessions,
    pickSurfaceSession,
    type SurfaceSessionInfo,
} from "@app/cmux/lib/command-capture";
import { loadSavedScreens, preferredScreenText } from "@app/cmux/lib/screen-cache";
import {
    captureSurfaceState,
    cwdFromTitle,
    lastCommandFromCapture,
    type SurfaceCaptureResult,
} from "@app/cmux/lib/shell-probe";
import type { Pane, Profile, ProfileScope, ScreenSnapshot, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { resolveWindowId } from "@app/cmux/lib/window-ref";
import { runCmux, runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import {
    browserUrl,
    type PaneListPane,
    paneList,
    type WindowEntry,
    type WorkspaceEntry,
    windowList,
    workspaceList,
} from "@genesiscz/utils/cmux/lib/socket";
import { sameCmuxId } from "@genesiscz/utils/cmux/lib/target";
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
export interface CommandCaptureContext {
    ttyCommands: Map<string, string>;
    panelTty: Map<string, string>;
    panelCwd: Map<string, string>;
    surfaceSessions: Map<string, SurfaceSessionInfo>;
    replayCatalog: ReplayCatalog;
    surfaceCommands?: Map<string, CapturedCommand>;
    panelScreens?: Map<string, ScreenSnapshot>;
    panelBrowserUrls?: Map<string, string>;
}

export function capturedCommandsByPanelId(
    autosave: AutosaveSession,
    commands: Map<string, CapturedCommand>
): Map<string, CapturedCommand> {
    const aliases = new Map([...commands].map(([id, command]) => [id.toLowerCase(), command]));

    for (const [id, panel] of panelsById(autosave)) {
        const command =
            (panel.stableSurfaceId ? commands.get(panel.stableSurfaceId.toLowerCase()) : undefined) ??
            commands.get(panel.id.toLowerCase());

        if (command) {
            aliases.set(id.toLowerCase(), command);
        }
    }

    return aliases;
}

export async function buildCommandCaptureContext(options: { commands?: boolean } = {}): Promise<CommandCaptureContext> {
    const [tty, surfaceSessions] =
        options.commands === false
            ? [
                  { launchCommands: new Map<string, string>(), claudeSessions: new Map<string, string>() },
                  // Annotated, not bare: an untyped `new Map()` widens the destructured binding to
                  // `Map<any, any>`, which is how a writer below came to omit a REQUIRED field with
                  // a clean typecheck.
                  new Map<string, SurfaceSessionInfo>(),
              ]
            : await Promise.all([collectTtyCapture(), loadSurfaceSessions()]);
    const ttyCommands = tty.launchCommands;
    const argvAccounts = await loadPinnedAccounts(tty.claudeSessions.values());

    // Read the autosave BEFORE the journal: its panel ids bound the journal scan to
    // the live surfaces instead of every surface this machine has ever had.
    let session: AutosaveSession | undefined;
    try {
        session = readAutosaveSession();
    } catch (error) {
        logger.debug({ error }, "[snapshot] autosave unavailable — foreground command capture degraded");
    }

    let surfaceCommands =
        options.commands === false
            ? new Map<string, CapturedCommand>()
            : loadCapturedCommands({ surfaceIds: session ? panelsById(session).keys() : undefined });
    const panelTty = new Map<string, string>();
    const panelCwd = new Map<string, string>();
    const panelScreens = new Map<string, ScreenSnapshot>();
    const cachedScreens = loadSavedScreens();
    const panelBrowserUrls = new Map<string, string>();
    const grokCwds: string[] = [];
    if (session) {
        try {
            surfaceCommands = capturedCommandsByPanelId(session, surfaceCommands);
            for (const [id, panel] of panelsById(session)) {
                const cached =
                    (panel.stableSurfaceId ? cachedScreens.get(panel.stableSurfaceId.toLowerCase()) : undefined) ??
                    cachedScreens.get(panel.id.toLowerCase());
                const text = preferredScreenText(panel.terminal?.scrollback, cached?.text);
                if (text) {
                    panelScreens.set(id.toLowerCase(), { text, rows: text.split("\n").length });
                }

                if (panel.browser?.urlString) {
                    panelBrowserUrls.set(id.toLowerCase(), panel.browser.urlString);
                }
                const surfaceSession =
                    (panel.stableSurfaceId ? surfaceSessions.get(panel.stableSurfaceId) : undefined) ??
                    surfaceSessions.get(panel.id);

                if (surfaceSession) {
                    surfaceSessions.set(id.toLowerCase(), surfaceSession);
                }

                const cwd = panelWorkingDirectory(panel);
                if (cwd) {
                    panelCwd.set(id.toLowerCase(), cwd);
                }
                if (panel.ttyName) {
                    panelTty.set(id.toLowerCase(), panel.ttyName);
                }

                // A `claude --resume <uuid>` on the pane's tty is the live session,
                // whatever the surface journal remembers from an earlier occupant.
                const argvSession = panel.ttyName ? tty.claudeSessions.get(panel.ttyName) : undefined;
                if (argvSession && argvSession !== surfaceSession?.sessionId) {
                    surfaceSessions.set(id.toLowerCase(), {
                        sessionId: argvSession,
                        // `claudeSessions` only ever holds ids read off a `claude … --resume <uuid>`
                        // argv, so the provider is known. Leaving it undefined made the replay path
                        // drop this entry at its `preferred?.kind === kind` gate and fall back to the
                        // fuzzy title match this branch exists to beat.
                        provider: "claude",
                        // Only a Claude account may attach to a Claude session id. A nested codex or
                        // grok run started from this pane leaves its own record on the surface, and
                        // an ungated fallback relaunched the pane under that other agent's account.
                        account:
                            argvAccounts.get(argvSession) ??
                            (surfaceSession?.provider === "claude" ? surfaceSession.account : undefined),
                    });
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
            logger.debug({ error }, "[snapshot] autosave unreadable — foreground command capture degraded");
        }
    }

    return {
        ttyCommands,
        panelTty,
        panelCwd,
        surfaceSessions,
        surfaceCommands,
        panelScreens,
        panelBrowserUrls,
        replayCatalog: { sessions: options.commands === false ? [] : await loadGrokCatalog(grokCwds) },
    };
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
    window_id: string;
}

export async function captureProfile(options: SnapshotOptions, progress: SnapshotProgress = {}): Promise<Profile> {
    const allWindows = await windowList();
    const allWorkspaces = await collectAllWorkspaces(allWindows);

    const ctx = await getIdentifyContext();
    const capture =
        options.captureHistory || options.captureScreen || options.captureCwd
            ? await buildCommandCaptureContext({ commands: options.captureHistory })
            : undefined;
    const targetWindowId = options.targetWindowRef ? resolveWindowId(options.targetWindowRef, allWindows) : undefined;
    const targetWorkspaces = filterWorkspaces(allWorkspaces, { ...options, targetWindowId }, ctx.focusedWorkspaceId);
    const targetWindowIds = new Set(targetWorkspaces.map((ws) => ws.window_id));
    const targetWindows = allWindows.filter((w) => targetWindowIds.has(w.id));

    const windowsOut: Window[] = [];
    let visited = 0;
    for (const window of targetWindows) {
        const wsForWindow = targetWorkspaces
            .filter((ws) => ws.window_id === window.id)
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

            // Read in the background. This used to select each workspace first, so every capture
            // (a `--list`, a `--dry-run`) visibly swapped the user's active workspace about 5 s per
            // workspace. cmux 0.65 answers `list-pane-surfaces` and `capture-pane` for a background
            // workspace (2026-10-14: 11 tabs in 4 background workspaces all read, focus untouched).
            const panes = await capturePanes(ws.id, options, ctx.callerSurfaceId, capture);
            const fresh = await paneList(ws.id);
            const captured = { panes, container: fresh.container_frame };

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
        const list = await workspaceList(window.id);
        for (const ws of list.workspaces) {
            out.push({ ...ws, window_id: window.id });
        }
    }
    return out;
}

interface IdentifyContext {
    focusedWorkspaceId?: string;
    /**
     * Surface where the save command itself is running. Capturing its visible screen
     * would record `tools cmux profiles save` as the bottom-of-screen content, which
     * then gets replayed verbatim into the restored pane — meta-circular and useless.
     * We skip screen capture for this one surface.
     */
    callerSurfaceId?: string;
}

export async function getIdentifyContext(): Promise<IdentifyContext> {
    try {
        const identify = await runCmuxJSON<{
            focused?: { workspace_id?: string };
            caller?: { surface_id?: string };
        }>(["--id-format", "both", "identify"]);
        return {
            focusedWorkspaceId: identify.focused?.workspace_id,
            callerSurfaceId: identify.caller?.surface_id,
        };
    } catch {
        return {};
    }
}

/** Joins by UUID; `--workspace` may name a workspace by its ref or its UUID. */
function filterWorkspaces(
    all: CollectedWorkspace[],
    options: SnapshotOptions & { targetWindowId?: string },
    focusedWorkspaceId: string | undefined
): CollectedWorkspace[] {
    if (options.scope === "all") {
        return all;
    }
    if (options.scope === "window") {
        const focusedWindowId = focusedWorkspaceId
            ? all.find((ws) => sameCmuxId(ws.id, focusedWorkspaceId))?.window_id
            : undefined;
        const windowId = options.targetWindowId ?? focusedWindowId ?? all[0]?.window_id;
        if (!windowId) {
            throw new Error("scope=window requires a focused workspace or --window <ref>");
        }
        const filtered = all.filter((ws) => sameCmuxId(ws.window_id, windowId));
        if (filtered.length === 0 && options.targetWindowRef) {
            throw new Error(`No window matches --window ${options.targetWindowRef}`);
        }
        return filtered;
    }
    const wanted = options.targetWorkspaceRef?.trim();
    const filtered = wanted
        ? all.filter((ws) => ws.ref === wanted || sameCmuxId(ws.id, wanted))
        : all.filter((ws) => (focusedWorkspaceId ? sameCmuxId(ws.id, focusedWorkspaceId) : ws.selected === true));
    if (filtered.length === 0 && !wanted) {
        throw new Error("scope=workspace requires a focused workspace or --workspace <ref>");
    }
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
    workspaceId: string,
    options: SnapshotOptions,
    callerSurfaceId: string | undefined,
    capture: CommandCaptureContext | undefined
): Promise<Pane[]> {
    const layout = await paneList(workspaceId);
    const panes: Pane[] = [];

    for (const paneInfo of layout.panes) {
        const surfacesInfo = await runCmuxJSON<ListPaneSurfacesResponse>([
            "--id-format",
            "both",
            "list-pane-surfaces",
            "--workspace",
            workspaceId,
            "--pane",
            paneInfo.id,
        ]);

        const sortedEntries = [...surfacesInfo.surfaces].sort((a, b) => a.index - b.index);
        const surfaces: Surface[] = [];
        let selectedIndex = 0;
        for (const surfaceEntry of sortedEntries) {
            if (surfaceEntry.selected) {
                selectedIndex = surfaces.length;
            }
            surfaces.push(await captureSurface(surfaceEntry, workspaceId, options, callerSurfaceId, capture));
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
    workspaceId: string,
    options: SnapshotOptions,
    callerSurfaceId: string | undefined,
    capture: CommandCaptureContext | undefined
): Promise<Surface> {
    const title = entry.title ?? "";
    if (entry.type === "browser") {
        const url = await browserUrl(entry.id ?? entry.ref);
        return {
            type: "browser",
            title,
            url: url || (entry.id ? capture?.panelBrowserUrls?.get(entry.id.toLowerCase()) : undefined),
        };
    }

    // Skip screen capture for the surface running this very save command — its
    // visible content is dominated by the `tools cmux profiles save` invocation
    // and the running clack prompts, which would replay back into the restored
    // pane verbatim. Other panes still get full screen capture.
    const isCaller = callerSurfaceId !== undefined && entry.id !== undefined && sameCmuxId(entry.id, callerSurfaceId);
    if (isCaller && options.captureScreen) {
        logger.debug({ surfaceRef: entry.ref }, "[snapshot] skipping screen capture for caller surface");
    }
    const captured = await captureSurfaceState(workspaceId, entry.id ?? entry.ref, {
        screen: options.captureScreen && !isCaller,
        history: options.captureHistory,
    });

    const surface = buildTerminalSurfaceSnapshot({
        entry,
        captureCwd: options.captureCwd,
        captureScreen: options.captureScreen && !isCaller,
        captureHistory: options.captureHistory,
        captured,
        capture,
    });

    return surface.type === "terminal" && entry.id ? { ...surface, surface_id: entry.id } : surface;
}

export function buildTerminalSurfaceSnapshot(input: {
    entry: SurfaceListEntry;
    captureCwd: boolean;
    captureScreen?: boolean;
    captureHistory?: boolean;
    captured: SurfaceCaptureResult;
    capture?: CommandCaptureContext;
}): Surface {
    const { entry, captureCwd, captured, capture } = input;
    const title = entry.title ?? "";
    const id = entry.id?.toLowerCase();
    const journal = id ? capture?.surfaceCommands?.get(id) : undefined;
    const fallbackScreen = id ? capture?.panelScreens?.get(id) : undefined;
    const screen = input.captureScreen !== false ? (captured.screen ?? fallbackScreen) : undefined;
    const cwd = captureCwd
        ? (journal?.cwd ?? (id ? capture?.panelCwd.get(id) : undefined) ?? cwdFromTitle(title))
        : undefined;

    if (input.captureHistory === false) {
        return { type: "terminal", title, cwd, screen };
    }

    // The tab's own agent among the journal's candidates, by what the tab last ran.
    const session = pickSurfaceSession(
        capture && entry.id
            ? (capture.surfaceSessions.get(id ?? entry.id) ?? capture.surfaceSessions.get(entry.id))
            : undefined,
        journal
    );
    const journalReplay = journal ? journalReplayCommand(journal, session) : undefined;

    if (journal && journalReplay && !isAgentLauncher(journalReplay.command)) {
        return {
            type: "terminal",
            title,
            cwd,
            screen,
            command: journal.command,
            command_source: "shell-journal",
            drift: [
                `exact command recovered from shell journal (${journal.phase}${journal.exitStatus !== undefined ? `, exit ${journal.exitStatus}` : ""})`,
            ],
        };
    }

    // The foreground process on the pane's tty beats scrollback parsing: a pane
    // running a fullscreen TUI (claude, grok, vim) shows no shell prompt to parse,
    // but its launch command is right there in the process table.
    const tty = id ? capture?.panelTty.get(id) : undefined;
    const foreground = tty ? capture?.ttyCommands.get(tty) : undefined;
    const textCommand = captured.command.value ? captured.command : lastCommandFromCapture(fallbackScreen?.text);
    const recorded = journal?.command ?? foreground ?? textCommand.value;
    const original = journalReplay?.command ?? recorded;
    // The kind comes from the journal RECORD, never from the tab title: typing it from the
    // title made any pane whose title ends in the word "grok" (including a shell in a
    // directory named grok) replay `grok -r <claude uuid>`, a session grok has never seen.
    //
    // 🛑 It is not always "claude" either. The SessionStart hook is shared, so Codex sessions
    // write to this journal too; hardcoding the kind replayed a Codex thread id as
    // `claude -r <codex uuid>` — the same defect from the other direction.
    const preferred: ReplayCatalogSession | undefined = session
        ? {
              kind: session.provider,
              sessionId: session.sessionId,
              cwd: cwd ?? "",
              title,
              account: session.account,
          }
        : undefined;
    const derived = replayCommandForSurface(
        { title, cwd, command: original, command_source: journal ? "shell-journal" : undefined },
        capture?.replayCatalog ?? { sessions: [] },
        preferred
    );
    if (!derived.command) {
        return { type: "terminal", title, cwd, screen };
    }

    const drift = [...(journalReplay?.drift ?? []), ...derived.drift];

    return {
        type: "terminal",
        title,
        cwd,
        screen,
        command: derived.command,
        command_source: journal
            ? "shell-journal"
            : foreground
              ? "foreground"
              : derived.command !== original
                ? "inferred"
                : textCommand.source,
        command_original: derived.command !== recorded ? recorded : undefined,
        drift: drift.length > 0 ? drift : undefined,
        resume_evidence: derived.evidence,
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

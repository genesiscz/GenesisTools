import { loadGrokCatalog, type ReplayCatalogSession, replayCommandForSurface } from "@app/cmux/lib/agent-replay";
import {
    type AutosaveSession,
    type AutosaveWorkspace,
    flattenLayout,
    panelWorkingDirectory,
    readAutosaveSession,
} from "@app/cmux/lib/autosave";
import { type CapturedCommand, loadCapturedCommands } from "@app/cmux/lib/capture-journal";
import {
    agentKindFromLauncher,
    collectTtyLaunchCommands,
    deriveReplayCommand,
    isAgentLauncher,
    loadSurfaceSessions,
    type SurfaceSessionInfo,
} from "@app/cmux/lib/command-capture";
import { loadSavedScreens, preferredScreenText, type SavedSurfaceScreen } from "@app/cmux/lib/screen-cache";
import { lastCommandFromCapture } from "@app/cmux/lib/shell-probe";
import type { Pane, Profile, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { logger } from "@genesiscz/utils/logger";

/**
 * Offline profile capture: builds a restorable profile WITHOUT the cmux socket,
 * from the app's autosave file (layout tree, panels with cwd/title/tty) joined
 * with the process table and the claude session journals. This is the rescue
 * path for a UI-thread livelock, where every socket state command starves.
 *
 * Native scrollback and browser URLs are preserved when the autosave contains
 * them. No live UI activation is required for this recovery path.
 */

const DEFAULT_CELL_WIDTH_PX = 8;
const DEFAULT_CELL_HEIGHT_PX = 17;

export interface OfflineCaptureDeps {
    ttyCommands: Map<string, string>;
    surfaceSessions: Map<string, SurfaceSessionInfo>;
    grokSessions?: ReplayCatalogSession[];
    surfaceCommands?: Map<string, CapturedCommand>;
    surfaceScreens?: Map<string, SavedSurfaceScreen>;
    captureScreen?: boolean;
}

export interface OfflineCaptureOptions {
    name: string;
    note?: string;
    captureScreen?: boolean;
}

export async function captureOfflineProfile(options: OfflineCaptureOptions): Promise<Profile> {
    const session = readAutosaveSession();
    const cwds = [
        ...session.windows.flatMap((window) =>
            window.tabManager.workspaces.flatMap((workspace) => [
                workspace.currentDirectory ?? "",
                ...workspace.panels.map((panel) => panel.directory ?? ""),
            ])
        ),
    ];
    const [ttyCommands, surfaceSessions] = await Promise.all([collectTtyLaunchCommands(), loadSurfaceSessions()]);
    const grokSessions = loadGrokCatalog(cwds);

    return buildOfflineProfile(
        session,
        {
            ttyCommands,
            surfaceSessions,
            grokSessions,
            surfaceCommands: loadCapturedCommands(),
            surfaceScreens: options.captureScreen === false ? undefined : loadSavedScreens(),
        },
        options
    );
}

export function buildOfflineProfile(
    session: AutosaveSession,
    deps: OfflineCaptureDeps,
    options: OfflineCaptureOptions
): Profile {
    const windows: Window[] = session.windows.map((window, windowIndex) => {
        const frame = window.frame ?? { x: 0, y: 0, width: 1920, height: 1080 };
        const selectedIndex = window.tabManager.selectedWorkspaceIndex ?? 0;

        const workspaces: Workspace[] = window.tabManager.workspaces.map((ws, wsIndex) => ({
            ref: `workspace:${wsIndex + 1}`,
            title: ws.customTitle || ws.processTitle || `workspace ${wsIndex + 1}`,
            selected: wsIndex === selectedIndex,
            current_directory: ws.currentDirectory,
            panes: buildOfflinePanes(
                ws,
                { x: 0, y: 0, width: frame.width, height: frame.height },
                { ...deps, captureScreen: options.captureScreen ?? deps.captureScreen }
            ),
        }));

        return {
            ref: `window:${windowIndex + 1}`,
            title: `Window ${windowIndex + 1}`,
            container_frame: { width: frame.width, height: frame.height },
            workspaces,
        };
    });

    return {
        version: PROFILE_VERSION,
        name: options.name,
        scope: "all",
        captured_at: new Date().toISOString(),
        cmux_version: `offline (autosave ${new Date(session.savedAtMs).toISOString()})`,
        note: options.note,
        windows,
    };
}

export function buildOfflinePanes(
    workspace: AutosaveWorkspace,
    frame: { x: number; y: number; width: number; height: number },
    deps: OfflineCaptureDeps
): Pane[] {
    const panelMap = new Map(workspace.panels.map((panel) => [panel.id, panel]));
    const leaves = flattenLayout(workspace.layout, frame);

    return leaves.map((leaf, paneIndex) => {
        const surfaces: Surface[] = [];
        let selectedSurfaceIndex = 0;

        for (const panelId of leaf.panelIds) {
            const panel = panelMap.get(panelId);
            if (!panel) {
                logger.warn({ panelId }, "[offline-snapshot] layout references an unknown panel — skipped");
                continue;
            }

            if (panelId === leaf.selectedPanelId) {
                selectedSurfaceIndex = surfaces.length;
            }

            if (panel.type === "browser") {
                surfaces.push({ type: "browser", title: panel.title ?? "", url: panel.browser?.urlString });
                continue;
            }

            const captured =
                (panel.stableSurfaceId ? deps.surfaceCommands?.get(panel.stableSurfaceId.toLowerCase()) : undefined) ??
                deps.surfaceCommands?.get(panel.id.toLowerCase());
            const cachedScreen =
                (panel.stableSurfaceId ? deps.surfaceScreens?.get(panel.stableSurfaceId.toLowerCase()) : undefined) ??
                deps.surfaceScreens?.get(panel.id.toLowerCase());
            const text = preferredScreenText(panel.terminal?.scrollback, cachedScreen?.text);
            const screen = deps.captureScreen !== false && text ? { text, rows: text.split("\n").length } : undefined;
            const original =
                captured?.command ??
                (panel.ttyName ? deps.ttyCommands.get(panel.ttyName) : undefined) ??
                panel.terminal?.tmuxStartCommand ??
                lastCommandFromCapture(text).value;
            const session =
                deps.surfaceSessions.get(panel.id) ??
                (panel.stableSurfaceId ? deps.surfaceSessions.get(panel.stableSurfaceId) : undefined);
            const cwd = captured?.cwd ?? panelWorkingDirectory(panel) ?? workspace.currentDirectory;

            if (captured && !isAgentLauncher(captured.command)) {
                surfaces.push({
                    type: "terminal",
                    title: panel.title ?? "",
                    screen,
                    cwd,
                    command: captured.command,
                    command_source: "shell-journal",
                    drift: [
                        `exact command recovered from shell journal (${captured.phase}${captured.exitStatus !== undefined ? `, exit ${captured.exitStatus}` : ""})`,
                    ],
                });
                continue;
            }
            const agent = panel.terminal?.agent;
            const binding = panel.terminal?.resumeBinding;
            const nativeKind = agent?.kind ?? binding?.kind;
            const nativeSessionId = agent?.sessionId ?? binding?.checkpointId;
            const launchArgs = agent?.launchCommand?.arguments ?? [];
            const headless = launchArgs.some((arg) =>
                ["-p", "--prompt", "--prompt-file", "--output-format"].includes(arg)
            );
            if (
                nativeKind &&
                nativeSessionId &&
                !headless &&
                (!captured || agentKindFromLauncher(captured.command) === nativeKind)
            ) {
                const quote = (arg: string) =>
                    /^[a-zA-Z0-9_./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
                const original = captured?.command ?? [nativeKind, ...launchArgs.slice(1)].map(quote).join(" ");
                const derived = deriveReplayCommand({
                    original,
                    sessionId: nativeSessionId,
                    account: session?.account,
                });
                surfaces.push({
                    type: "terminal",
                    title: panel.title ?? "",
                    screen,
                    cwd: captured?.cwd ?? agent?.workingDirectory ?? binding?.cwd ?? cwd,
                    command: derived.command,
                    command_source: captured ? "shell-journal" : "offline",
                    command_original: captured && derived.command !== captured.command ? captured.command : undefined,
                    resume: { kind: nativeKind, sessionId: nativeSessionId },
                    drift: [`resume target recovered from cmux autosave (${nativeKind})`, ...derived.drift],
                });
                continue;
            }
            // Always "claude": the surface-session journal only records Claude
            // sessions, so typing the kind from the tab title turned a claude
            // uuid into a `grok -r` argument on any pane whose title ends in
            // the word "grok".
            const preferred: ReplayCatalogSession | undefined = session
                ? {
                      kind: "claude",
                      sessionId: session.sessionId,
                      cwd: cwd ?? "",
                      title: panel.title ?? "",
                      account: session.account,
                  }
                : undefined;

            const derived = replayCommandForSurface(
                {
                    title: panel.title ?? "",
                    cwd,
                    command: original,
                    command_source: captured ? "shell-journal" : undefined,
                },
                { sessions: deps.grokSessions ?? [] },
                preferred
            );

            surfaces.push({
                type: "terminal",
                title: panel.title ?? "",
                screen,
                cwd,
                command: derived.command,
                command_source: derived.command ? (captured ? "shell-journal" : "offline") : undefined,
                command_original: derived.command && derived.command !== original ? original : undefined,
                drift: derived.drift.length > 0 ? derived.drift : undefined,
            });
        }

        return {
            ref: `pane:${paneIndex + 1}`,
            index: paneIndex,
            columns: Math.max(20, Math.round(leaf.frame.width / DEFAULT_CELL_WIDTH_PX)),
            rows: Math.max(5, Math.round(leaf.frame.height / DEFAULT_CELL_HEIGHT_PX)),
            pixel_frame: leaf.frame,
            selected_surface_index: selectedSurfaceIndex,
            surfaces,
        };
    });
}

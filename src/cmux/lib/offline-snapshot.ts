import { loadGrokCatalog, type ReplayCatalogSession, replayCommandForSurface } from "@app/cmux/lib/agent-replay";
import {
    type AutosaveSession,
    type AutosaveWorkspace,
    flattenLayout,
    readAutosaveSession,
} from "@app/cmux/lib/autosave";
import { collectTtyLaunchCommands, loadSurfaceSessions, type SurfaceSessionInfo } from "@app/cmux/lib/command-capture";
import type { Pane, Profile, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { logger } from "@genesiscz/utils/logger";

/**
 * Offline profile capture: builds a restorable profile WITHOUT the cmux socket,
 * from the app's autosave file (layout tree, panels with cwd/title/tty) joined
 * with the process table and the claude session journals. This is the rescue
 * path for a UI-thread livelock, where every socket state command starves.
 *
 * Not captured offline: visible screen contents (needs `capture-pane`) and
 * browser URLs. Both degrade gracefully on restore.
 */

const DEFAULT_CELL_WIDTH_PX = 8;
const DEFAULT_CELL_HEIGHT_PX = 17;

export interface OfflineCaptureDeps {
    ttyCommands: Map<string, string>;
    surfaceSessions: Map<string, SurfaceSessionInfo>;
    grokSessions?: ReplayCatalogSession[];
}

export interface OfflineCaptureOptions {
    name: string;
    note?: string;
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

    return buildOfflineProfile(session, { ttyCommands, surfaceSessions, grokSessions }, options);
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
            panes: buildOfflinePanes(ws, { x: 0, y: 0, width: frame.width, height: frame.height }, deps),
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
                surfaces.push({ type: "browser", title: panel.title ?? "" });
                continue;
            }

            const original = panel.ttyName ? deps.ttyCommands.get(panel.ttyName) : undefined;
            const session = deps.surfaceSessions.get(panel.id);
            // Always "claude": the surface-session journal only records Claude
            // sessions, so typing the kind from the tab title turned a claude
            // uuid into a `grok -r` argument on any pane whose title ends in
            // the word "grok".
            const preferred: ReplayCatalogSession | undefined = session
                ? {
                      kind: "claude",
                      sessionId: session.sessionId,
                      cwd: panel.directory ?? "",
                      title: panel.title ?? "",
                      account: session.account,
                  }
                : undefined;

            const derived = replayCommandForSurface(
                { title: panel.title ?? "", cwd: panel.directory, command: original },
                { sessions: deps.grokSessions ?? [] },
                preferred
            );

            surfaces.push({
                type: "terminal",
                title: panel.title ?? "",
                cwd: panel.directory,
                command: derived.command,
                command_source: derived.command ? "offline" : undefined,
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

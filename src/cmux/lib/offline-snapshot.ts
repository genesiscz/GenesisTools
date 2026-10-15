import {
    type AutosavePanel,
    type AutosaveSession,
    type AutosaveWorkspace,
    flattenLayout,
    panelsById,
    panelWorkingDirectory,
    readAutosaveSession,
} from "@app/cmux/lib/autosave";
import { type CapturedCommand, loadCapturedCommands } from "@app/cmux/lib/capture-journal";
import { loadGrokCatalog, type ReplayCatalogSession } from "@app/cmux/lib/replay-catalog";
import { resolveTabSession } from "@app/cmux/lib/resolve-tab";
import { loadSavedScreens, preferredScreenText, type SavedSurfaceScreen } from "@app/cmux/lib/screen-cache";
import { lastCommandFromCapture } from "@app/cmux/lib/shell-probe";
import { loadSurfaceSessions, type SurfaceSessionInfo } from "@app/cmux/lib/surface-sessions";
import { collectTtyLaunchCommands } from "@app/cmux/lib/tty-capture";
import type { Pane, Profile, Surface, Window, Workspace } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { grokSessionsRoot } from "@genesiscz/utils/agent-sessions/grok-sessions";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { cmuxIdKey } from "@genesiscz/utils/cmux/lib/target";
import { env } from "@genesiscz/utils/env";
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

interface NativeResumeRecord {
    kind: AccountProviderAlias;
    sessionId: string;
    /** argv of the launch that owns the id, for rebuilding the command when no capture exists. */
    launchArgs: string[];
}

/**
 * The ONE autosave record that names both the agent and the session to resume.
 *
 * 🛑 `terminal.agent.sessionId` is optional, so reading the kind off `agent` and the id off
 * `resumeBinding` through two independent `??` chains let the pair disagree: a claude `agent`
 * with no session id beside a codex `resumeBinding` emitted `claude --resume <codex uuid>`,
 * a session claude has never seen. That is the exact defect `SurfaceSessionInfo.provider`
 * warns about, arriving through the autosave file instead of the journal. The kind, the id
 * and the argv all come from whichever record actually carries an id.
 */
function nativeResumeRecord(panel: AutosavePanel): NativeResumeRecord | undefined {
    const agent = panel.terminal?.agent;
    const binding = panel.terminal?.resumeBinding;

    if (agent?.sessionId) {
        return { kind: agent.kind, sessionId: agent.sessionId, launchArgs: agent.launchCommand?.arguments ?? [] };
    }

    if (binding?.checkpointId) {
        // A binding records no argv, so the command is rebuilt from the launcher name alone.
        // The agent's argv belongs to the agent, and splicing it here is how the two halves
        // got mixed in the first place.
        return { kind: binding.kind, sessionId: binding.checkpointId, launchArgs: [] };
    }

    return undefined;
}

export interface OfflineCaptureDeps {
    ttyCommands: Map<string, string>;
    surfaceSessions: Map<string, SurfaceSessionInfo>;
    grokSessions?: ReplayCatalogSession[];
    surfaceCommands?: Map<string, CapturedCommand>;
    surfaceScreens?: Map<string, SavedSurfaceScreen>;
    captureScreen?: boolean;
    /**
     * The surface running the save, lowercased. Its screen is skipped, the same rule the online
     * path applies through `isCaller` (`snapshot.ts`): that pane shows the `tools cmux profiles
     * save` invocation and the clack prompts, and restore would `cat` them back verbatim.
     *
     * The offline path cannot ask cmux who called it — that socket is the thing that is down —
     * so it reads `CMUX_SURFACE_ID`, which is the same id `capture-shell.zsh` keys its spool on.
     */
    callerSurfaceId?: string;
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
    const callerSurfaceId = env.getProcessEnv().CMUX_SURFACE_ID?.toLowerCase() || undefined;
    const [ttyCommands, surfaceSessions] = await Promise.all([collectTtyLaunchCommands(), loadSurfaceSessions()]);
    // This is the livelock rescue: the shared history database may be held by a starving process,
    // and a full grok discovery walks tens of thousands of files. Read the index or read nothing.
    const grokSessions = await loadGrokCatalog(cwds, grokSessionsRoot(), { cached: true });

    return buildOfflineProfile(
        session,
        {
            ttyCommands,
            surfaceSessions,
            grokSessions,
            surfaceCommands: loadCapturedCommands({ surfaceIds: panelsById(session).keys() }),
            surfaceScreens: options.captureScreen === false ? undefined : loadSavedScreens(),
            ...(callerSurfaceId === undefined ? {} : { callerSurfaceId }),
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

/** Reconstruct pane geometry and replayable surfaces from autosave panels, journals and cached screens without cmux RPCs. */
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
            const isCaller =
                deps.callerSurfaceId !== undefined &&
                (panel.id.toLowerCase() === deps.callerSurfaceId ||
                    panel.stableSurfaceId?.toLowerCase() === deps.callerSurfaceId);

            if (isCaller && deps.captureScreen !== false) {
                logger.debug({ panelId: panel.id }, "[offline-snapshot] skipping screen capture for caller surface");
            }

            const text = preferredScreenText(panel.terminal?.scrollback, cachedScreen?.text);
            const screen =
                deps.captureScreen !== false && !isCaller && text ? { text, rows: text.split("\n").length } : undefined;
            const cwd = captured?.cwd ?? panelWorkingDirectory(panel) ?? workspace.currentDirectory;
            const record = nativeResumeRecord(panel);
            const agent = panel.terminal?.agent;
            const resolved = resolveTabSession(
                {
                    title: panel.title ?? "",
                    cwd,
                    shellLine: captured,
                    recorded: deps.surfaceSessions.get(cmuxIdKey(panel.id)),
                    fallback: {
                        command:
                            (panel.ttyName ? deps.ttyCommands.get(panel.ttyName) : undefined) ??
                            panel.terminal?.tmuxStartCommand ??
                            lastCommandFromCapture(text).value,
                        source: "offline",
                        rewrittenSource: "offline",
                    },
                    native: record
                        ? {
                              ...record,
                              // Headless is a property of the PANE, so it is read from the agent record even when the
                              // id came from the binding: a `-p` run must never be restored as an interactive resume.
                              headless: (agent?.launchCommand?.arguments ?? []).some((arg) =>
                                  ["-p", "--prompt", "--prompt-file", "--output-format"].includes(arg)
                              ),
                              cwd: agent?.workingDirectory ?? panel.terminal?.resumeBinding?.cwd,
                              bindingConfirms:
                                  panel.terminal?.resumeBinding?.kind === record.kind &&
                                  panel.terminal?.resumeBinding?.checkpointId === record.sessionId,
                          }
                        : undefined,
                },
                { sessions: deps.grokSessions ?? [] }
            );

            surfaces.push({
                type: "terminal",
                surface_id: panel.id,
                title: panel.title ?? "",
                screen,
                cwd: resolved.cwd ?? cwd,
                command: resolved.command,
                command_source: resolved.source,
                command_original: resolved.original,
                ...(resolved.resume ? { resume: resolved.resume } : {}),
                drift: resolved.drift.length > 0 ? resolved.drift : undefined,
                resume_evidence: resolved.evidence,
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

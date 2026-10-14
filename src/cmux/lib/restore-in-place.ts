import { agentKindFromLauncher, isAgentLauncher, resumeTargetFromCommand } from "@app/cmux/lib/command-capture";
import { type RestoreOptions, replayTerminal } from "@app/cmux/lib/restore";
import { liveTree } from "@app/cmux/lib/session-close-live";
import { isShellPromptReady } from "@app/cmux/lib/terminal-ready";
import type { Profile, TerminalSurface } from "@app/cmux/lib/types";
import { runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { appendSessionCmuxRef } from "@genesiscz/utils/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";
import { listProcesses, type ProcessEntry } from "@genesiscz/utils/process/processes";

/** A terminal tab of the live layout, from `cmux tree`. */
export interface LiveTab {
    ref: string;
    /** The surface UUID. */
    id: string;
    workspace: string;
    workspaceId: string | null;
    window: string;
    tty: string | null;
    title: string | null;
}

/** A captured terminal tab, and what `--in-place` types into its live counterpart. */
export interface InPlaceStep {
    workspaceRef: string;
    workspaceTitle: string;
    /** Undefined when the tab is gone from the live layout. */
    surfaceRef?: string;
    live?: LiveTab;
    title: string;
    surface: TerminalSurface;
    /** `agent` resumes a session; `command` types the tab's last shell command for review. */
    kind: "agent" | "command";
    /** Set when the tab is left alone. */
    skip?: string;
}

export interface InPlaceLiveState {
    /** Surface UUID (lower case) → the live tab. */
    tabs: Map<string, LiveTab>;
    /** The ttys that run nothing but a shell. */
    idleTtys: Set<string>;
    /** Surface ref → the text the terminal shows now, read for idle tabs only. */
    screens: Map<string, string>;
    /** The tab running this restore. It is never typed into. */
    callerSurfaceRef?: string;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu"]);

/**
 * The ttys where this user runs only shells. Any other process of the user on the tty (an agent, an ssh, a
 * `tail -f`, a background job) makes the tab busy. `login` is root's, so it is not counted.
 */
export function idleShellTtys(processes: ProcessEntry[], uid: number): Set<string> {
    const byTty = new Map<string, ProcessEntry[]>();

    for (const entry of processes) {
        if (entry.tty && entry.uid === uid && !entry.zombie) {
            byTty.set(entry.tty, [...(byTty.get(entry.tty) ?? []), entry]);
        }
    }

    const idle = new Set<string>();

    for (const [tty, entries] of byTty) {
        if (entries.every((entry) => SHELLS.has(entry.name.replace(/^-/, "")))) {
            idle.add(tty);
        }
    }

    return idle;
}

function skipReason(surface: TerminalSurface, live: LiveTab | undefined, state: InPlaceLiveState): string | undefined {
    if (!surface.surface_id) {
        return "the capture holds no surface id for this tab";
    }

    if (!live) {
        return "the tab is no longer in the live layout";
    }

    if (live.ref === state.callerSurfaceRef) {
        return "this tab runs the restore";
    }

    if (!surface.command) {
        return "nothing is recorded to restore here";
    }

    const agent = isAgentLauncher(surface.command);

    if (!live.tty || !state.idleTtys.has(live.tty)) {
        // Say what the journal names, so a tab that runs the WRONG agent (cmux's own restore picked a
        // stale session) is visible instead of passing as "busy".
        return agent
            ? `a program already runs here; the recorded session for this tab is: ${surface.command}`
            : "a program already runs here";
    }

    if (!isShellPromptReady(state.screens.get(live.ref) ?? "")) {
        return "the prompt is not empty (text is typed at it), so nothing is typed";
    }

    if (!agent) {
        return undefined;
    }

    if (!resumeTargetFromCommand(surface.command)) {
        return "no session id resolved, so the command would open a new session or a picker";
    }

    if (surface.resume_evidence === "weak") {
        return `only weak evidence ties this tab to the session (see the drift); if it is right, type: ${surface.command}`;
    }

    return undefined;
}

/**
 * What `--in-place` does in each captured tab. A tab is paired with the live one by its surface UUID, which
 * cmux keeps across a relaunch. Only a tab whose tty runs nothing but a shell, with an empty prompt, is
 * typed into: it gets its agent session back, or its last shell command for review. The caller's own tab,
 * a busy tab, and a session tied to the tab by weak evidence are skipped with the reason.
 */
export function planInPlaceRestore(profile: Profile, state: InPlaceLiveState): InPlaceStep[] {
    const steps: InPlaceStep[] = [];

    for (const window of profile.windows) {
        for (const workspace of window.workspaces) {
            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces) {
                    if (surface.type !== "terminal") {
                        continue;
                    }

                    const live = surface.surface_id ? state.tabs.get(surface.surface_id.toLowerCase()) : undefined;

                    steps.push({
                        workspaceRef: live?.workspace ?? workspace.ref,
                        workspaceTitle: workspace.title,
                        surfaceRef: live?.ref,
                        live,
                        title: surface.title,
                        surface,
                        kind: surface.command && isAgentLauncher(surface.command) ? "agent" : "command",
                        skip: skipReason(surface, live, state),
                    });
                }
            }
        }
    }

    return steps;
}

/** The live tabs, which ttys are idle, and the screens of the idle tabs. Nothing here changes focus. */
export async function readInPlaceLiveState(): Promise<InPlaceLiveState> {
    const tree = await liveTree();
    const uid = process.getuid?.() ?? -1;
    const idleTtys = idleShellTtys(listProcesses({ commands: false }), uid);
    const tabs = new Map<string, LiveTab>();
    const screens = new Map<string, string>();

    for (const tab of tree.surfaces.values()) {
        if (!tab.id) {
            continue;
        }

        tabs.set(tab.id.toLowerCase(), {
            ref: tab.ref,
            id: tab.id,
            workspace: tab.workspace,
            workspaceId: tab.workspaceId,
            window: tab.window,
            tty: tab.tty,
            title: tab.title,
        });

        if (!tab.tty || !idleTtys.has(tab.tty) || tab.ref === tree.caller) {
            continue;
        }

        const screen = await runCmux(["read-screen", "--workspace", tab.workspace, "--surface", tab.ref]);
        if (screen.code !== 0) {
            logger.debug({ surface: tab.ref, stderr: screen.stderr }, "[restore-in-place] screen unreadable");
            continue;
        }

        screens.set(tab.ref, screen.stdout);
    }

    return { tabs, idleTtys, screens, callerSurfaceRef: tree.caller ?? undefined };
}

/**
 * Journal the session this restore put into the tab, as the cmux hook would. The resumed agent writes its own
 * record only where the genesis-tools plugin loaded; this record does not depend on that, so the next relaunch
 * can find the tab's session by its surface UUID.
 */
function recordResumedSession(step: InPlaceStep): void {
    const command = step.surface.command ?? "";
    const sessionId = resumeTargetFromCommand(command);
    const provider = agentKindFromLauncher(command);

    if (step.kind !== "agent" || !sessionId || !provider || !step.live) {
        return;
    }

    try {
        appendSessionCmuxRef({
            sessionId,
            provider,
            workspaceId: step.live.workspaceId,
            surfaceId: step.live.id,
            workspaceRef: step.live.workspace,
            paneRef: null,
            surfaceRef: step.live.ref,
            windowRef: step.live.window,
            tmuxPane: null,
            cwd: step.surface.cwd ?? null,
        });
    } catch (error) {
        logger.warn(
            { error, sessionId, surface: step.live.ref },
            "[restore-in-place] could not journal the resumed session"
        );
    }
}

/**
 * Types each planned step into its tab. An agent resume runs when `enter` is set; a shell command runs only
 * with `runCommands`, otherwise it waits at the prompt for review. Resolves to one message per failed tab.
 */
export async function runInPlaceRestore(
    steps: InPlaceStep[],
    opts: Pick<RestoreOptions, "enter" | "replay"> & { runCommands: boolean },
    events: { onStep?: (step: InPlaceStep, index: number, total: number) => void } = {}
): Promise<string[]> {
    const planned = steps.filter((step) => !step.skip && step.surfaceRef);
    const failures: string[] = [];

    for (const [index, step] of planned.entries()) {
        const surfaceRef = step.surfaceRef ?? "";
        const enter = step.kind === "agent" ? opts.enter : opts.runCommands;
        events.onStep?.(step, index + 1, planned.length);

        try {
            // The tab already shows its own shell. Printing the captured screen back would only
            // duplicate it, so the screen is left out and the tab gets the cd and the command.
            const reason = await replayTerminal({ ...step.surface, screen: undefined }, step.workspaceRef, surfaceRef, {
                prefix: "",
                replay: opts.replay,
                enter: enter && opts.replay,
                yes: true,
                dryRun: false,
            });

            if (reason) {
                failures.push(`${step.title}: ${reason}`);
                continue;
            }

            recordResumedSession(step);
        } catch (error) {
            logger.warn({ error, surface: surfaceRef }, "[restore-in-place] resume failed");
            failures.push(`${step.title} (${surfaceRef}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return failures;
}

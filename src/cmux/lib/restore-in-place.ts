import { agentKindFromLauncher, isAgentLauncher, resumeTargetFromCommand } from "@app/cmux/lib/command-capture";
import { type RestoreOptions, replayTerminal } from "@app/cmux/lib/restore";
import { liveTree } from "@app/cmux/lib/session-close-live";
import { isShellPromptReady, waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import type { Profile, TerminalSurface } from "@app/cmux/lib/types";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { runCmux, runCmuxOk, sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { appendSessionCmuxRef } from "@genesiscz/utils/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";
import { listProcesses, type ProcessEntry } from "@genesiscz/utils/process/processes";

/**
 * A terminal tab of the live layout, from `cmux --id-format both tree --all`. Every identity is a UUID: cmux
 * renumbers the `surface:N` refs at each relaunch. The ref is kept for display only.
 */
export interface LiveTab {
    /** Surface UUID. */
    id: string;
    /** Workspace UUID. */
    workspaceId: string | null;
    tty: string | null;
    title: string | null;
    /** `surface:N`, for the plan's display only. */
    ref: string;
    workspaceRef: string;
    windowRef: string;
}

/** An agent session running on a tty, read off its process command line. */
export interface TtyAgent {
    kind: AccountProviderAlias;
    sessionId?: string;
}

/**
 * Work done in a tab before the command is typed.
 * - `clear-prompt`: the tab's shell is idle but text sits at its prompt. Ctrl-E then Ctrl-U clears the line
 *   (Ctrl-U alone keeps what is right of the cursor in bash and zsh vi mode); zsh keeps the text on its kill
 *   ring, so Ctrl-Y brings it back.
 * - `quit-stale-agent`: the tab runs another agent session than the surface journal names, and that agent
 *   still waits at its directory-trust prompt, so it never opened its session. Answering "n" quits it.
 */
export type InPlacePrepare = "clear-prompt" | "quit-stale-agent";

/** A captured terminal tab, and what `--in-place` does in its live counterpart. */
export interface InPlaceStep {
    workspaceTitle: string;
    /** Undefined when the tab is gone from the live layout. */
    live?: LiveTab;
    title: string;
    surface: TerminalSurface;
    /** `agent` resumes a session; `command` types the tab's last shell command for review. */
    kind: "agent" | "command";
    prepare?: InPlacePrepare;
    /** What the preparation touches, printed in the plan. */
    prepareNote?: string;
    /** Set when the tab is left alone. */
    skip?: string;
}

export interface InPlaceLiveState {
    /** Surface UUID (lower case) → the live tab. */
    tabs: Map<string, LiveTab>;
    /** The ttys that run nothing but a shell. */
    idleTtys: Set<string>;
    /** tty → the agent running there, for busy ttys. */
    ttyAgents: Map<string, TtyAgent>;
    /** Surface UUID (lower case) → the text the terminal shows now. */
    screens: Map<string, string>;
    /** The surface UUID (lower case) of the tab running this restore. It is never typed into. */
    callerId?: string;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu"]);

/** Grok's first-run dialog. Until it is answered, grok has not opened the session it was asked to resume. */
const GROK_TRUST_PROMPT = /Do you trust the contents of this directory\?[\s\S]*No, quit\s+n\b/;

/**
 * The ttys where this user runs exactly one process, and it is a shell: the tab's own login shell, waiting at
 * its prompt. Any other process (an agent, an ssh, a `tail -f`, a background job) makes the tab busy, and so
 * does a SECOND shell: a script that runs under `bash` and waits for input looks like a shell by name, and
 * typing into it would feed its stdin (2026-10-14, caught by the live proof). `login` is root's, so it is not
 * counted.
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
        if (entries.length === 1 && SHELLS.has(entries[0].name.replace(/^-/, ""))) {
            idle.add(tty);
        }
    }

    return idle;
}

/** The agent each busy tty runs, from the first agent command line on it (`/…/grok -r <id>`, `claude --resume <id>`). */
export function agentsOnTtys(processes: ProcessEntry[], uid: number): Map<string, TtyAgent> {
    const agents = new Map<string, TtyAgent>();

    for (const entry of processes) {
        if (!entry.tty || entry.uid !== uid || entry.zombie || !entry.command || agents.has(entry.tty)) {
            continue;
        }

        const command = entry.command.replace(/^\S*\/(?=(?:claude|grok|codex)(?:\s|$))/, "");
        const kind = agentKindFromLauncher(command);

        if (kind && /^(?:claude|grok|codex)(?:\s|$)/.test(command)) {
            agents.set(entry.tty, { kind, sessionId: resumeTargetFromCommand(command) });
        }
    }

    return agents;
}

function lastLine(screen: string): string {
    return (
        screen
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .at(-1) ?? ""
    );
}

interface Decision {
    skip?: string;
    prepare?: InPlacePrepare;
    prepareNote?: string;
}

function decide(surface: TerminalSurface, live: LiveTab | undefined, state: InPlaceLiveState): Decision {
    if (!surface.surface_id) {
        return { skip: "the capture holds no surface id for this tab" };
    }

    if (!live) {
        return { skip: "the tab is no longer in the live layout" };
    }

    if (live.id.toLowerCase() === state.callerId) {
        return { skip: "this tab runs the restore" };
    }

    if (!surface.command) {
        return { skip: "nothing is recorded to restore here" };
    }

    const agent = isAgentLauncher(surface.command);
    const target = agent ? resumeTargetFromCommand(surface.command) : undefined;

    if (agent && !target) {
        return { skip: "no session id resolved, so the command would open a new session or a picker" };
    }

    if (surface.resume_evidence === "weak") {
        return {
            skip: `only weak evidence ties this tab to the session (see the drift); if it is right, type: ${surface.command}`,
        };
    }

    // cmux reports no tty for a tab it has never drawn (one opened in the background and never shown), and
    // without the tty nothing proves the tab runs only a shell.
    if (!live.tty) {
        return { skip: "cmux reports no tty for this tab yet (it was never shown); show the tab once and run again" };
    }

    const screen = state.screens.get(live.id.toLowerCase()) ?? "";

    if (!state.idleTtys.has(live.tty)) {
        const running = state.ttyAgents.get(live.tty);

        if (agent && running?.sessionId && running.sessionId === target) {
            return { skip: "already runs the recorded session" };
        }

        // cmux's own relaunch restore can start a stale session in the tab. While that agent still waits at
        // its trust prompt it has opened nothing, so quitting it loses nothing.
        if (agent && running?.kind === "grok" && GROK_TRUST_PROMPT.test(screen)) {
            return {
                prepare: "quit-stale-agent",
                prepareNote: `quits grok ${running.sessionId ?? "(no session)"}, which waits at its trust prompt; the surface journal names this tab's session`,
            };
        }

        return {
            skip: agent
                ? `a program already runs here${running ? ` (${running.kind} ${running.sessionId ?? "without a session id"})` : ""}; the recorded session for this tab is: ${surface.command}`
                : "a program already runs here",
        };
    }

    if (!isShellPromptReady(screen)) {
        return {
            prepare: "clear-prompt",
            prepareNote: `clears the prompt line first (Ctrl-E, Ctrl-U; zsh keeps the text, Ctrl-Y brings it back): ${lastLine(screen).slice(0, 100)}`,
        };
    }

    return {};
}

/**
 * What `--in-place` does in each captured tab. A tab is paired with the live one by its surface UUID, which
 * cmux keeps across a relaunch. A tab whose tty runs only a shell gets its agent session back, or its last
 * shell command for review; stray text at its prompt is cleared first. A busy tab is skipped, except a stale
 * agent still waiting at its trust prompt, which is quit first. The caller's own tab and a session tied to
 * the tab by weak evidence are skipped with the reason.
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
                        workspaceTitle: workspace.title,
                        live,
                        title: surface.title,
                        surface,
                        kind: surface.command && isAgentLauncher(surface.command) ? "agent" : "command",
                        ...decide(surface, live, state),
                    });
                }
            }
        }
    }

    return steps;
}

/** The live tabs, which ttys are idle or run an agent, and every tab's screen. Nothing here changes focus. */
export async function readInPlaceLiveState(): Promise<InPlaceLiveState> {
    const tree = await liveTree();
    const uid = process.getuid?.() ?? -1;
    const processes = listProcesses();
    const tabs = new Map<string, LiveTab>();
    const screens = new Map<string, string>();
    const callerId = tree.callerId?.toLowerCase();

    for (const tab of tree.surfaces.values()) {
        if (!tab.id) {
            continue;
        }

        const id = tab.id.toLowerCase();
        tabs.set(id, {
            id: tab.id,
            workspaceId: tab.workspaceId,
            tty: tab.tty,
            title: tab.title,
            ref: tab.ref,
            workspaceRef: tab.workspace,
            windowRef: tab.window,
        });

        if (id === callerId) {
            continue;
        }

        // A UUID names the surface across the whole tree, so the workspace adds nothing (target.ts).
        const screen = await runCmux(["read-screen", "--surface", tab.id]);
        if (screen.code !== 0) {
            logger.debug({ surface: tab.id, stderr: screen.stderr }, "[restore-in-place] screen unreadable");
            continue;
        }

        screens.set(id, screen.stdout);
    }

    return {
        tabs,
        idleTtys: idleShellTtys(processes, uid),
        ttyAgents: agentsOnTtys(processes, uid),
        screens,
        callerId,
    };
}

/**
 * Clear the prompt line and wait until the shell shows an empty prompt. Ctrl-E first: Ctrl-U kills only what
 * is left of the cursor in bash and in zsh's vi keymap, so the cursor goes to the end of the line before it.
 * If the prompt is still not empty, nothing is typed (the wait throws).
 */
async function clearPrompt(live: LiveTab): Promise<void> {
    await runCmuxOk(["send-key", "--surface", live.id, "ctrl-e"]);
    await runCmuxOk(["send-key", "--surface", live.id, "ctrl-u"]);
    await waitForTerminalText({
        workspaceId: live.workspaceId ?? live.workspaceRef,
        surfaceId: live.id,
        matches: isShellPromptReady,
        description: "an empty prompt after Ctrl-U",
        timeoutMs: 5_000,
    });
}

/**
 * Answer grok's trust prompt with "n", wait for the shell, and clear the line zsh redraws there. The plan
 * read the screen earlier; the dialog is checked again right before the key, because an "n" typed into an
 * agent that has moved past the dialog would land in its chat.
 */
async function quitStaleAgent(live: LiveTab): Promise<void> {
    if (!live.tty) {
        throw new Error(`cmux reports no tty for ${live.ref}, so nothing could prove the agent quit; nothing was sent`);
    }

    const now = await runCmux(["read-screen", "--surface", live.id]);

    if (now.code !== 0 || !GROK_TRUST_PROMPT.test(now.stdout)) {
        throw new Error(`${live.ref} no longer shows grok's trust prompt; nothing was sent`);
    }

    await sendSurfaceText({ surfaceRef: live.id, text: "n" });
    const processesGone = async () => {
        const left = listProcesses().filter((entry) => entry.tty === live.tty && !entry.zombie);
        return idleShellTtys(left, process.getuid?.() ?? -1).has(live.tty ?? "");
    };
    const deadline = Date.now() + 15_000;

    while (!(await processesGone())) {
        if (Date.now() > deadline) {
            throw new Error(`the agent in ${live.ref} did not quit within 15 s after "n"`);
        }

        await Bun.sleep(250);
    }

    await clearPrompt(live);
}

/** Runs the step's preparation in its live tab: clear the prompt line, or quit a stale agent at its trust prompt. */
export async function prepareTab(step: Pick<InPlaceStep, "prepare" | "live">): Promise<void> {
    if (!step.live || !step.prepare) {
        return;
    }

    if (step.prepare === "quit-stale-agent") {
        await quitStaleAgent(step.live);
        return;
    }

    await clearPrompt(step.live);
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
            workspaceRef: step.live.workspaceRef,
            paneRef: null,
            surfaceRef: step.live.ref,
            windowRef: step.live.windowRef,
            tmuxPane: null,
            cwd: step.surface.cwd ?? null,
        });
    } catch (error) {
        logger.warn(
            { error, sessionId, surface: step.live.id },
            "[restore-in-place] could not journal the resumed session"
        );
    }
}

/**
 * Prepares and types each planned step into its tab. An agent resume runs when `enter` is set; a shell
 * command runs only with `runCommands`, otherwise it waits at the prompt for review. Resolves to one message
 * per failed tab.
 */
export async function runInPlaceRestore(
    steps: InPlaceStep[],
    opts: Pick<RestoreOptions, "enter" | "replay"> & { runCommands: boolean },
    events: { onStep?: (step: InPlaceStep, index: number, total: number) => void } = {}
): Promise<string[]> {
    const planned = steps.filter((step) => !step.skip && step.live);
    const failures: string[] = [];

    for (const [index, step] of planned.entries()) {
        const live = step.live;

        if (!live) {
            continue;
        }

        const enter = step.kind === "agent" ? opts.enter : opts.runCommands;
        events.onStep?.(step, index + 1, planned.length);

        try {
            await prepareTab(step);

            // The tab already shows its own shell. Printing the captured screen back would only
            // duplicate it, so the screen is left out and the tab gets the cd and the command.
            const reason = await replayTerminal(
                { ...step.surface, screen: undefined },
                live.workspaceId ?? live.workspaceRef,
                live.id,
                { prefix: "", replay: opts.replay, enter: enter && opts.replay, yes: true, dryRun: false }
            );

            if (reason) {
                failures.push(`${step.title}: ${reason}`);
                continue;
            }

            // Only a resume that ran puts the session in the tab; a typed, unsubmitted command does not.
            if (enter && opts.replay) {
                recordResumedSession(step);
            }
        } catch (error) {
            logger.warn({ error, surface: live.id }, "[restore-in-place] tab not restored");
            failures.push(`${step.title} (${live.ref}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return failures;
}

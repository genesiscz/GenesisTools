import { agentKindFromLauncher, isAgentLauncher, resumeTargetFromCommand } from "@app/cmux/lib/command-capture";
import { profileSurfaces } from "@app/cmux/lib/profile-walk";
import { type RestoreOptions, replayTerminal } from "@app/cmux/lib/restore";
import { liveTree } from "@app/cmux/lib/session-close-live";
import { agentsOnTtys, idleShellTtys, runningAgentSessions, type TtyAgent } from "@app/cmux/lib/tab-process";
import { classifyPrompt, isShellPromptReady, waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import type { Profile, TerminalSurface } from "@app/cmux/lib/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { runCmux, runCmuxJSON, runCmuxOk, sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { cmuxIdKey } from "@genesiscz/utils/cmux/lib/target";
import { appendSessionCmuxRef } from "@genesiscz/utils/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";
import { listProcesses } from "@genesiscz/utils/process/processes";
import pc from "picocolors";

/**
 * A terminal tab of the live layout, from `cmux --id-format both tree --all`. Every identity is a UUID: cmux
 * renumbers the `surface:N` refs at each relaunch. The ref is kept for display only.
 */
export interface LiveTab {
    /** Surface UUID. */
    id: string;
    /** Workspace, pane and window UUIDs. */
    workspaceId: string | null;
    paneId?: string | null;
    windowId?: string | null;
    tty: string | null;
    /**
     * False when cmux's tty for this tab cannot be believed: another tab reports the same tty, or the tab's
     * renderer has not started yet. Right after a relaunch (cmux 0.65.1, 2026-10-15) four of fourteen
     * background tabs reported another tab's tty, two of them shared with a tab that was drawn; cmux corrected
     * them only after the tabs got input. Such a tab is judged by its screen alone. Undefined means trusted.
     */
    ttyTrusted?: boolean;
    title: string | null;
    /** `surface:N`, for the plan's display only. */
    ref: string;
    workspaceRef: string;
    windowRef: string;
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
    /**
     * The skip may only mean the tab's shell is still starting (its init runs a program, or the prompt is not
     * drawn yet), so a later read can plan the tab.
     */
    retry?: boolean;
}

export interface InPlaceLiveState {
    /** Surface UUID (lower case) → the live tab. */
    tabs: Map<string, LiveTab>;
    /** The ttys that run nothing but a shell. */
    idleTtys: Set<string>;
    /** tty → the agent running there, for busy ttys. */
    ttyAgents: Map<string, TtyAgent>;
    /** Every recognized running session id → its tty or `(no tty)`, including agents sharing a tty. */
    runningSessions: Map<string, string>;
    /** Surface UUID (lower case) → the text the terminal shows now. */
    screens: Map<string, string>;
    /** The surface UUID (lower case) of the tab running this restore. It is never typed into. */
    callerId?: string;
}

/** Grok's first-run dialog. Until it is answered, grok has not opened the session it was asked to resume. */
const TYPABLE_EVIDENCE: ReadonlySet<string> = new Set(["journal", "typed", "title"]);

const GROK_TRUST_PROMPT = /Do you trust the contents of this directory\?[\s\S]*No, quit\s+n\b/;

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
    retry?: boolean;
}

/** The tty that runs this agent session now, in any tab. */
function ttyRunning(sessionId: string, state: InPlaceLiveState): string | undefined {
    return state.runningSessions.get(sessionId.toLowerCase());
}

function decide(surface: TerminalSurface, live: LiveTab | undefined, state: InPlaceLiveState): Decision {
    if (!surface.surface_id) {
        return { skip: "the capture holds no surface id for this tab" };
    }

    // Before the live check: a captured tab with no command (a markdown or browser surface) is not a terminal
    // in the live tree, and "gone" would be wrong.
    if (!surface.command) {
        return { skip: "nothing is recorded to restore here" };
    }

    if (!live) {
        return { skip: "the tab is no longer in the live layout" };
    }

    if (live.id.toLowerCase() === state.callerId) {
        return { skip: "this tab runs the restore" };
    }

    const agent = isAgentLauncher(surface.command);
    const target = agent ? resumeTargetFromCommand(surface.command) : undefined;

    if (agent && !target) {
        return { skip: "no session id resolved, so the command would open a new session or a picker" };
    }

    if (agent && surface.resume_evidence === "weak") {
        return {
            skip: `only weak evidence ties this tab to the session (see the drift); if it is right, type: ${surface.command}`,
        };
    }

    // An allowlist, not a denylist: a path that forgot to say why it chose the session is not typed (Sonnet F7).
    if (agent && !TYPABLE_EVIDENCE.has(surface.resume_evidence ?? "none")) {
        return {
            skip: `no evidence recorded for this session (see the drift); if it is right, type: ${surface.command}`,
        };
    }

    // cmux reports no tty for a tab it has never drawn (one opened in the background and never shown), and
    // without the tty nothing proves the tab runs only a shell.
    if (!live.tty) {
        return { skip: "cmux reports no tty for this tab yet (it was never shown); show the tab once and run again" };
    }

    // A second `--resume` of a running session forks it, whichever tab the running one is in.
    const runningOn = agent && target ? ttyRunning(target, state) : undefined;

    if (runningOn !== undefined) {
        return {
            skip:
                runningOn === live.tty
                    ? "already runs the recorded session"
                    : `the recorded session already runs on ${runningOn}, not on this tab's ${live.tty}`,
        };
    }

    const screen = state.screens.get(live.id.toLowerCase());

    if (live.ttyTrusted !== false && !state.idleTtys.has(live.tty)) {
        const running = state.ttyAgents.get(live.tty);

        if (agent && running?.sessionId && running.sessionId === target?.toLowerCase()) {
            return { skip: "already runs the recorded session" };
        }

        // cmux's own relaunch restore can start a stale session in the tab. While that agent still waits at
        // its trust prompt it has opened nothing, so quitting it loses nothing.
        if (agent && running?.kind === "grok" && screen !== undefined && GROK_TRUST_PROMPT.test(screen)) {
            return {
                prepare: "quit-stale-agent",
                prepareNote: `quits grok ${running.sessionId ?? "(no session)"}, which waits at its trust prompt; the surface journal names this tab's session`,
            };
        }

        return {
            skip: agent
                ? `a program already runs here${running ? ` (${running.kind} ${running.sessionId ?? "without a session id"})` : ""}; the recorded session for this tab is: ${surface.command}`
                : "a program already runs here",
            // An unnamed program right after a relaunch is often the shell's own init still running.
            ...(running ? {} : { retry: true }),
        };
    }

    if (screen === undefined) {
        return { skip: "cmux could not read this tab's screen, so nothing proves its prompt is empty", retry: true };
    }

    const prompt = classifyPrompt(screen);

    if (prompt.kind === "typed") {
        return {
            prepare: "clear-prompt",
            prepareNote: `clears the prompt line first (Ctrl-E, Ctrl-U; zsh keeps the text, Ctrl-Y brings it back): ${prompt.text.slice(0, 100)}`,
        };
    }

    if (prompt.kind === "unknown") {
        return {
            skip: `the last line is not a shell prompt this restore knows: ${lastLine(screen).slice(0, 100)}`,
            // "You have mail." stood last while the prompt was not drawn yet (2026-10-15).
            retry: true,
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

    for (const { workspace, surface } of profileSurfaces(profile)) {
        if (surface.type !== "terminal") {
            continue;
        }

        const live = surface.surface_id ? state.tabs.get(cmuxIdKey(surface.surface_id)) : undefined;

        steps.push({
            workspaceTitle: workspace.title,
            live,
            title: surface.title,
            surface,
            kind: surface.command && isAgentLauncher(surface.command) ? "agent" : "command",
            ...decide(surface, live, state),
        });
    }

    return steps;
}

/**
 * The plan, read again while a tab is skipped for a reason that a starting shell explains (see
 * {@link InPlaceStep.retry}). A restore started right after a relaunch met shells still running their init and
 * prompts not drawn yet; a second read a minute later planned every tab (2026-10-15).
 */
export async function planInPlaceSettled(
    profile: Profile,
    options: { read?: () => Promise<InPlaceLiveState>; attempts?: number; delayMs?: number } = {}
): Promise<InPlaceStep[]> {
    const read = options.read ?? readInPlaceLiveState;
    const attempts = options.attempts ?? 3;
    let steps = planInPlaceRestore(profile, await read());

    for (let attempt = 1; attempt < attempts && steps.some((step) => step.retry); attempt++) {
        await Bun.sleep(options.delayMs ?? 2000);
        steps = planInPlaceRestore(profile, await read());
    }

    return steps;
}

/** Surface UUIDs (lower case) whose renderer has not started, from `cmux surface-health` per workspace. */
async function unstartedSurfaces(workspaceIds: Iterable<string>): Promise<Set<string>> {
    const unstarted = new Set<string>();

    for (const workspaceId of workspaceIds) {
        try {
            const health = await runCmuxJSON<{ surfaces?: Array<{ id?: string; render_health?: string | null }> }>([
                "--id-format",
                "both",
                "surface-health",
                "--workspace",
                workspaceId,
            ]);

            for (const surface of health.surfaces ?? []) {
                if (surface.id && surface.render_health === "not_started") {
                    unstarted.add(surface.id.toLowerCase());
                }
            }
        } catch (error) {
            // An older cmux without the command: every tty stays trusted, as before.
            logger.debug({ error, workspaceId }, "[restore-in-place] surface-health unavailable");
        }
    }

    return unstarted;
}

/** Read tab and process ownership without changing focus; optionally read only the target surface's screen. */
export async function readInPlaceLiveState(options: { surfaceId?: string } = {}): Promise<InPlaceLiveState> {
    const tree = await liveTree();
    const uid = process.getuid?.() ?? -1;
    const processes = listProcesses();
    const tabs = new Map<string, LiveTab>();
    const screens = new Map<string, string>();
    const callerId = tree.callerId?.toLowerCase();

    const ttyCounts = new Map<string, number>();
    const workspaceIds = new Set<string>();

    for (const tab of tree.surfaces.values()) {
        if (tab.tty) {
            ttyCounts.set(tab.tty, (ttyCounts.get(tab.tty) ?? 0) + 1);
        }

        if (tab.workspaceId) {
            workspaceIds.add(tab.workspaceId);
        }
    }

    const unstarted = await unstartedSurfaces(workspaceIds);

    for (const tab of tree.surfaces.values()) {
        if (!tab.id) {
            continue;
        }

        const id = tab.id.toLowerCase();
        tabs.set(id, {
            id: tab.id,
            workspaceId: tab.workspaceId,
            paneId: tab.paneId ?? null,
            windowId: tab.windowId ?? null,
            tty: tab.tty,
            ttyTrusted: !unstarted.has(id) && (tab.tty ? (ttyCounts.get(tab.tty) ?? 0) < 2 : true),
            title: tab.title,
            ref: tab.ref,
            workspaceRef: tab.workspace,
            windowRef: tab.window,
        });
    }

    // Three at a time, 3 s each: one read per tab at the 30 s default stacked to minutes on a starved cmux
    // (review F23). A read that fails or times out leaves the tab without a screen, which the plan skips.
    // A refresh for one restored tab reads only that tab's screen.
    // A UUID names the surface across the whole tree, so the workspace adds nothing (target.ts).
    const onlyId = options.surfaceId !== undefined ? cmuxIdKey(options.surfaceId) : undefined;
    const readable = [...tabs.values()].filter((tab) => {
        const id = tab.id.toLowerCase();
        return id !== callerId && (onlyId === undefined || id === onlyId);
    });
    const read = await concurrentMap({
        items: readable,
        concurrency: 3,
        fn: (tab) => runCmux(["read-screen", "--surface", tab.id], { timeoutMs: 3000 }),
        onError: (tab, error) => logger.debug({ error, surface: tab.id }, "[restore-in-place] screen read failed"),
    });

    for (const [tab, screen] of read) {
        if (screen.code !== 0) {
            logger.debug({ surface: tab.id, stderr: screen.stderr }, "[restore-in-place] screen unreadable");
            continue;
        }

        screens.set(tab.id.toLowerCase(), screen.stdout);
    }

    return {
        tabs,
        idleTtys: idleShellTtys(processes, uid),
        ttyAgents: agentsOnTtys(processes, uid),
        runningSessions: runningAgentSessions(processes, uid),
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
            paneId: step.live.paneId ?? null,
            windowId: step.live.windowId ?? null,
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
    events: {
        onStep?: (step: InPlaceStep, index: number, total: number) => void;
        read?: () => Promise<InPlaceLiveState>;
    } = {}
): Promise<string[]> {
    const planned = steps.filter((step) => !step.skip && step.live);
    const failures: string[] = [];

    for (const [index, step] of planned.entries()) {
        let live = step.live;

        if (!live) {
            continue;
        }

        const enter = step.kind === "agent" ? opts.enter : opts.runCommands;
        events.onStep?.(step, index + 1, planned.length);

        try {
            const read = events.read ?? (() => readInPlaceLiveState({ surfaceId: step.surface.surface_id }));
            const refresh = async (): Promise<InPlaceStep> => {
                const state = await read();
                const current = state.tabs.get(cmuxIdKey(step.surface.surface_id ?? ""));
                return {
                    ...step,
                    live: current,
                    skip: undefined,
                    prepare: undefined,
                    prepareNote: undefined,
                    retry: undefined,
                    ...decide(step.surface, current, state),
                };
            };
            const current = await refresh();

            if (current.skip || !current.live || current.live.tty !== live.tty) {
                failures.push(`${step.title}: ${current.skip ?? "the tab's tty changed since planning"}`);
                continue;
            }

            live = current.live;
            await prepareTab({ live, prepare: current.prepare });
            const ready = await refresh();

            if (ready.skip || !ready.live || ready.live.tty !== live.tty || ready.prepare) {
                failures.push(`${step.title}: ${ready.skip ?? "the tab changed before replay"}`);
                continue;
            }

            live = ready.live;

            // The tab already shows its own shell. Printing the captured screen back would only
            // duplicate it, so the screen is left out and the tab gets the cd and the command.
            const reason = await replayTerminal(
                { ...step.surface, screen: undefined },
                live.workspaceId ?? live.workspaceRef,
                live.id,
                { replay: opts.replay, enter: enter && opts.replay, neverFocus: true }
            );

            if (reason) {
                failures.push(`${step.title}: ${reason}`);
                continue;
            }

            // Only a resume that ran puts the session in the tab; a typed, unsubmitted command does not.
            if (enter && opts.replay) {
                recordResumedSession({ ...step, live });
            }
        } catch (error) {
            logger.warn({ error, surface: live.id }, "[restore-in-place] tab not restored");
            failures.push(`${step.title} (${live.ref}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return failures;
}

/** One plan line per tab: what is typed, what is done first, or why the tab is skipped. */
export function renderInPlaceStep(step: InPlaceStep): string {
    const where = `${pc.cyan(step.workspaceTitle)} › ${step.title || pc.dim("(untitled)")} ${pc.dim(step.live?.ref ?? "(gone)")}`;

    if (step.skip) {
        return `  ${pc.dim("·")} ${where}\n      ${pc.dim(`skip: ${step.skip}`)}`;
    }

    const label = step.kind === "agent" ? "resume" : "type (shell command)";
    const prepare = step.prepareNote ? `\n      ${pc.yellow(`first: ${step.prepareNote}`)}` : "";

    return `  ${pc.green("▶")} ${where}${prepare}\n      ${pc.dim(`${label}:`)} ${step.surface.command}`;
}

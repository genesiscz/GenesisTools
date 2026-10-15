import { replayCommandForSurface } from "@app/cmux/lib/agent-replay";
import type { CapturedCommand } from "@app/cmux/lib/capture-journal";
import { journalReplayCommand } from "@app/cmux/lib/command-capture";
import { agentKindFromLauncher, isAgentLauncher } from "@app/cmux/lib/launchers";
import { deriveReplayCommand } from "@app/cmux/lib/render-resume";
import type { ReplayCatalog, ReplayCatalogSession } from "@app/cmux/lib/replay-catalog";
import { pickSurfaceSession, type SurfaceSessionInfo, staleSessionNote } from "@app/cmux/lib/surface-sessions";
import type { CommandSource, ResumeEvidence } from "@app/cmux/lib/types";
import type { AgentKind } from "@genesiscz/utils/agent-sessions/types";
import { shellWord } from "@genesiscz/utils/shell/quote";

/** A session cmux's own autosave names for the tab (its agent record or resume binding). Offline capture only. */
export interface NativeTabSession {
    kind: AgentKind;
    sessionId: string;
    /** The agent's recorded argv; empty for a resume binding, which records none. */
    launchArgs: string[];
    /** The tab ran the agent headless (`-p`): it is never restored as an interactive resume. */
    headless: boolean;
    /** The directory the agent record or binding names. */
    cwd?: string;
    /** The tab's cmux resume binding names this same session, which corroborates the agent record. */
    bindingConfirms?: boolean;
}

/** What is known about one tab, from whichever source the capture path reads. */
export interface TabEvidence {
    title: string;
    cwd?: string;
    /** The tab's last command from the local shell journal. */
    shellLine?: CapturedCommand;
    /** The surface journal's sessions for the tab, every agent (surface-sessions.ts). */
    recorded?: SurfaceSessionInfo;
    /**
     * The command read some other way when the shell journal has none: the tty's foreground process, a tmux start
     * command, or the screen. `rewrittenSource` labels it when the resolver changed it.
     */
    fallback?: { command?: string; source: CommandSource; rewrittenSource: CommandSource };
    native?: NativeTabSession;
}

export interface TabResolution {
    /** Undefined when nothing is recorded to run here. */
    command?: string;
    source?: CommandSource;
    /** The recorded command when the resolution changed it. */
    original?: string;
    drift: string[];
    evidence?: ResumeEvidence;
    /** Set when cmux's autosave named the session. */
    resume?: { kind: AgentKind; sessionId: string };
    /** A directory that beats the tab's own (the autosave agent's). */
    cwd?: string;
}

/**
 * The one decision of which session (or shell command) a tab restores, shared by the live capture (snapshot.ts)
 * and the offline one (offline-snapshot.ts). In order:
 * 1. The surface journal's session of the tab's own agent (`pickSurfaceSession`), judged against the shell
 *    journal's last line (`journalReplayCommand`): a shell command the tab ran after its last agent session
 *    replays as it was.
 * 2. Offline only: the session cmux's autosave names, when the shell line names no other agent.
 * 3. The catalog by title (`replayCommandForSurface`), with the journal session as the preferred hit.
 * Every step adds its reason to the drift, so the plan shows why the tab got its command.
 */
export function resolveTabSession(evidence: TabEvidence, catalog: ReplayCatalog): TabResolution {
    const { shellLine, recorded, native } = evidence;
    const session = pickSurfaceSession(recorded, shellLine);
    const lineReplay = shellLine ? journalReplayCommand(shellLine, session) : undefined;

    if (shellLine && lineReplay && !isAgentLauncher(lineReplay.command)) {
        return {
            command: shellLine.command,
            source: "shell-journal",
            drift: [
                `exact command recovered from shell journal (${shellLine.phase}${shellLine.exitStatus !== undefined ? `, exit ${shellLine.exitStatus}` : ""})`,
                // A tab that ran an agent and then went back to a shell still carries its resume binding. The shell
                // line wins, because it is what the tab last did, but the binding is named so a session is never
                // dropped in silence.
                ...(native
                    ? [
                          `cmux also holds a ${native.kind} resume binding here (${native.sessionId}); the captured command won`,
                      ]
                    : []),
            ],
        };
    }

    const lineCommand = lineReplay?.command;
    const recordedCommand = shellLine?.command ?? evidence.fallback?.command;
    const original = lineCommand ?? recordedCommand;

    if (native && !native.headless && (!lineCommand || agentKindFromLauncher(lineCommand) === native.kind)) {
        const derived = deriveReplayCommand({
            original: lineCommand ?? [native.kind, ...native.launchArgs.slice(1)].map(shellWord).join(" "),
            sessionId: native.sessionId,
            account: session?.account,
        });

        return {
            command: derived.command,
            source: shellLine ? "shell-journal" : "offline",
            original: shellLine && derived.command !== shellLine.command ? shellLine.command : undefined,
            resume: { kind: native.kind, sessionId: native.sessionId },
            // Process-derived native metadata may be stale; the tab's own journal or binding must agree.
            evidence:
                (session?.provider === native.kind && session.sessionId === native.sessionId) ||
                native.bindingConfirms
                    ? "journal"
                    : undefined,
            cwd: shellLine?.cwd ?? native.cwd,
            drift: [
                `resume target recovered from cmux autosave (${native.kind})`,
                ...(lineReplay?.drift ?? []),
                ...derived.drift,
            ],
        };
    }

    // The kind comes from the journal RECORD, never from the tab title: typing it from the title made any tab whose
    // title ends in the word "grok" (including a shell in a directory named grok) replay `grok -r <claude uuid>`. It
    // is not always "claude" either: Codex and Grok sessions write to this journal too.
    const preferred: ReplayCatalogSession | undefined = session
        ? {
              kind: session.provider,
              sessionId: session.sessionId,
              cwd: evidence.cwd ?? "",
              title: evidence.title,
              account: session.account,
          }
        : undefined;
    const derived = replayCommandForSurface(
        {
            title: evidence.title,
            cwd: evidence.cwd,
            command: original,
            command_source: shellLine ? "shell-journal" : undefined,
        },
        catalog,
        preferred
    );

    if (!derived.command) {
        return { drift: derived.drift };
    }

    const fallback = evidence.fallback;

    return {
        command: derived.command,
        source: shellLine
            ? "shell-journal"
            : derived.command !== original
              ? (fallback?.rewrittenSource ?? "inferred")
              : (fallback?.source ?? "none"),
        original: derived.command !== recordedCommand ? recordedCommand : undefined,
        evidence: derived.evidence,
        drift: [...staleSessionNote(recorded, session, shellLine), ...(lineReplay?.drift ?? []), ...derived.drift],
    };
}

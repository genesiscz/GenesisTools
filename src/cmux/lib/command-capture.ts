import type { CapturedCommand } from "@app/cmux/lib/capture-journal";
import { isAgentLauncher } from "@app/cmux/lib/launchers";
import { agentRunLauncher } from "@app/cmux/lib/session-agents";
import type { SurfaceSessionInfo } from "@app/cmux/lib/surface-sessions";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions/resume-argv";
import { carryAgentFlags } from "@genesiscz/utils/agent-sessions/resume-flags";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { shellWord } from "@genesiscz/utils/shell/quote";

/**
 * What a tab's shell-journal line restores as (`journalReplayCommand`). The rest of the old command-capture
 * module lives by job: the tty process capture in tty-capture.ts, launcher recognition in launchers.ts, the
 * surface-journal sessions in surface-sessions.ts, and every resume writer in render-resume.ts.
 */
/** The line cmux types into a tab when it relaunches and resumes an agent from its own record. */
const CMUX_RESTORE_RE = /^\s*cmux\s+restore\s+(\S+)\s+(\S+)\s*$/;
const CMUX_RESTORE_KINDS: readonly AccountProviderAlias[] = ["claude", "grok", "codex"];

/**
 * The command a shell-journal line restores as.
 *
 * - A known agent launcher is returned as it was; the replay path pins the session onto it.
 * - `cmux restore <kind> <id>`, which cmux types itself at relaunch, yields to the surface journal when the
 *   journal names another session for the tab.
 * - A line `tools cmux agents new` typed (pid note, absolute `tools` path, first prompt) becomes its plain
 *   launcher, so restore resumes the session instead of sending the first prompt again.
 * - Any other line is judged by the tab's surface journal, not by its words. The user can start an agent
 *   through any alias, function or wrapper this code has never seen. When the journal saw an agent session
 *   in this tab AFTER the line started, that session was the tab's last occupant and the tab resumes it.
 *   Otherwise the line itself was the last thing the tab did and it replays verbatim.
 */
export function journalReplayCommand(
    journal: Pick<CapturedCommand, "command" | "atMs">,
    session?: SurfaceSessionInfo
): { command: string; drift: string[] } {
    if (isAgentLauncher(journal.command)) {
        return { command: journal.command, drift: [] };
    }

    const cmuxRestore = journal.command.match(CMUX_RESTORE_RE);
    const kind = CMUX_RESTORE_KINDS.find((candidate) => candidate === cmuxRestore?.[1]);

    if (cmuxRestore && kind) {
        const sessionId = cmuxRestore[2];

        // cmux types this line itself when it relaunches, from its own agent record, which can be stale
        // (2026-10-14: it put a day-old grok session into the tab where claude 1b4001ba ran until the crash).
        // It is not the user's activity, so the record time does not count against the surface journal.
        if (session && session.sessionId !== sessionId) {
            return {
                command: resumeCommandLine(session.provider, session.sessionId, session.account),
                drift: [
                    `cmux's own restore typed \`cmux restore ${kind} ${sessionId}\` here, but the surface journal saw ${session.provider} session ${session.sessionId} in this tab last; the tab resumes that session`,
                ],
            };
        }

        return {
            command: resumeCommandLine(kind, sessionId, session?.provider === kind ? session.account : undefined),
            drift: [`cmux's own restore named ${kind} session ${sessionId} for this tab`],
        };
    }

    const run = agentRunLauncher(journal.command);

    if (run) {
        return {
            command: run.launcher,
            drift: [
                `\`${toolCommand("cmux", "agents", "new")}\` ${run.agent} tab: resumes its session, the first prompt is not sent again`,
            ],
        };
    }

    if (session?.at !== undefined && session.at >= journal.atMs) {
        const typed = journal.command.split("\n")[0].slice(0, 60);
        const flags = carryAgentFlags(session.provider, journal.command);
        const resume = resumeCommandLine(session.provider, session.sessionId, session.account);

        return {
            command: [resume, ...flags.kept.map(shellWord)].join(" "),
            drift: [
                `the surface journal saw ${session.provider} session ${session.sessionId} in this tab after \`${typed}\` started, so the tab resumes that session`,
                ...(flags.kept.length > 0 ? [`kept ${session.provider}'s own flags: ${flags.kept.join(" ")}`] : []),
                ...(flags.unresolved.length > 0
                    ? [
                          `dropped ${flags.unresolved.join(", ")}: unresolved shell expansion; the captured text has no concrete argv value`,
                      ]
                    : []),
                ...(flags.dropped.length > 0
                    ? [
                          `dropped ${flags.dropped.join(" ")}: not a ${session.provider} flag a resume may carry (a model, a resume, or the wrapper's own)`,
                      ]
                    : []),
            ],
        };
    }

    return { command: journal.command, drift: [] };
}

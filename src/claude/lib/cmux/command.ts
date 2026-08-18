import type { PlannedSession } from "@app/claude/lib/cmux/types";
import { shellSingleQuote } from "@app/claude/lib/shell-quote";

export interface LaunchCommandOptions {
    /** Add `-a` so a pane with no recorded account picks the best one instead of asking. */
    autopick?: boolean;
}

/**
 * The shell line a restored pane runs.
 *
 * `--resume <id>` goes AFTER `--` so claude receives it verbatim. Passing it as
 * `tools claude start --resume <id>` would hand the id to the local session SEARCH
 * (`pickSessionForResume`), which prompts — exactly what an unattended restore must
 * not do. `tools claude start` still sees the flag through its passthrough and skips
 * its own resume prompts.
 *
 * `cd` is a separate statement rather than a subshell so the pane is left in the
 * session's directory after claude exits, ready for a relaunch.
 */
export function buildLaunchCommand(session: PlannedSession, opts: LaunchCommandOptions = {}): string {
    const parts = ["tools", "claude", "start"];

    if (session.account) {
        parts.push(shellSingleQuote(session.account));
    } else if (opts.autopick) {
        parts.push("-a");
    }

    if (session.model) {
        parts.push("-m", shellSingleQuote(session.model));
    }

    parts.push("--", "--resume", shellSingleQuote(session.candidate.sessionId));

    return `cd -- ${shellSingleQuote(session.candidate.cwd)} && ${parts.join(" ")}`;
}

/** Tab title for a restored pane: short and identifying, since panes get narrow. */
export function paneTitle(session: PlannedSession): string {
    const { candidate } = session;
    const where = candidate.subdir ? `${candidate.project}/${candidate.subdir}` : candidate.project;

    return `${where} · ${candidate.sessionId.slice(0, 8)}`;
}

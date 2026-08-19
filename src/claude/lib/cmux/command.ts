import type { PlannedSession } from "@app/claude/lib/cmux/types";
import { shellSingleQuote } from "@app/claude/lib/shell-quote";

export interface LaunchCommandOptions {
    /** Add `-a` so a pane with no recorded account picks the best one instead of asking. */
    autopick?: boolean;
}

/**
 * True when the session is known to have run on a keychain login, with no account name.
 *
 * A null account has two meanings, and collapsing them resumes a session under
 * the wrong credential. `pinned` is what separates them: pinned with no account
 * is the hook reporting "this ran with TOOLS_CLAUDE_ACCOUNT unset", a real
 * answer; unpinned is "nobody ever recorded this session".
 */
function ranOnBareKeychain(session: PlannedSession): boolean {
    return session.account === null && session.candidate.pinned;
}

/**
 * True when the session ran as a NAMED account through the keychain (`--keychain`).
 *
 * Both auth modes export the same TOOLS_CLAUDE_ACCOUNT, so the account name alone
 * cannot tell them apart. Without the recorded mode, `tools claude start work` would
 * resume a `--keychain work` session on work's long-lived token instead: a different
 * credential than the one the session ran on. Pins written before `auth` existed have
 * no opinion, and keep the token path they have always used.
 */
function ranOnNamedKeychain(session: PlannedSession): boolean {
    return session.account !== null && session.candidate.auth === "keychain";
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
 * A keychain session resumes as a bare `claude`, which is exactly how it ran the
 * first time. Routing it through `tools claude start` would put it in front of the
 * account picker (or, with `-a`, silently onto a token account), so the pane would
 * come back billed to someone else.
 *
 * `cd` is a separate statement rather than a subshell so the pane is left in the
 * session's directory after claude exits, ready for a relaunch.
 */
export function buildLaunchCommand(session: PlannedSession, opts: LaunchCommandOptions = {}): string {
    const keychain = ranOnBareKeychain(session);
    const parts = keychain ? ["claude"] : ["tools", "claude", "start"];

    if (session.account) {
        parts.push(shellSingleQuote(session.account));

        // Same account, same auth mode: `--keychain` injects the account's secondary
        // login instead of exporting its token, which is how the session ran.
        if (ranOnNamedKeychain(session)) {
            parts.push("--keychain");
        }
    } else if (opts.autopick && !session.candidate.pinned) {
        parts.push("-a");
    }

    if (session.model) {
        // `-m` is the wrapper's flag; claude itself spells it `--model`.
        parts.push(keychain ? "--model" : "-m", shellSingleQuote(session.model));
    }

    // A bare `claude` takes `--resume` directly; only the wrapper needs the separator.
    if (!keychain) {
        parts.push("--");
    }

    parts.push("--resume", shellSingleQuote(session.candidate.sessionId));

    return `cd -- ${shellSingleQuote(session.candidate.cwd)} && ${parts.join(" ")}`;
}

/** Tab title for a restored pane: short and identifying, since panes get narrow. */
export function paneTitle(session: PlannedSession): string {
    const { candidate } = session;
    const where = candidate.subdir ? `${candidate.project}/${candidate.subdir}` : candidate.project;
    // The name you gave the session first, because the command line can only carry the
    // session ID: `claude --resume <name>` is not a lookup, it opens a picker with the
    // name as a search term, which would stall an unattended restore. So the tab is
    // where the readable name lives. The short ID stays to tell two alike names apart.
    const name = candidate.title?.replace(/\s+/g, " ").trim();
    const lead = name ? (name.length > TAB_NAME_MAX ? `${name.slice(0, TAB_NAME_MAX - 1)}…` : name) : where;

    return `${lead} · ${candidate.sessionId.slice(0, 8)}`;
}

/** cmux tabs are narrow; past this the name is cut before the ID, not after. */
const TAB_NAME_MAX = 32;

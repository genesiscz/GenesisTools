import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

/**
 * Commands that are not meaningful as an auto-name — a session sitting at a shell prompt should fall
 * back to its tmux name / spawn command, not be labeled "zsh". Long-running foreground processes
 * (claude, vim, node, …) ARE meaningful, so anything not in this set becomes the auto-name.
 */
const UNINTERESTING_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login", "tmux"]);

/** A `pane_current_command` worth surfacing as a name (a real foreground process, not the shell). */
export function isMeaningfulCommand(command: string | undefined): command is string {
    if (!command) {
        return false;
    }

    const trimmed = command.trim();
    return trimmed.length > 0 && !UNINTERESTING_COMMANDS.has(trimmed);
}

/**
 * The display name for a ttyd session, honoring the precedence the user asked for — a MANUAL name
 * always wins, so the automatic command-derived name never overwrites a hand-set one:
 *
 *   1. `name`          — explicit rename (the in-terminal pencil or a cmux rename). Sticky.
 *   2. `lastCommand`   — the live foreground command, when it is meaningful (auto-name).
 *   3. `tmuxSessionName` — the bound tmux session.
 *   4. `command`       — the spawn command (always present).
 */
export function deriveTtydDisplayName(session: TtydSession): string {
    const manual = session.name?.trim();

    if (manual) {
        return manual;
    }

    if (isMeaningfulCommand(session.lastCommand)) {
        return session.lastCommand.trim();
    }

    return session.tmuxSessionName ?? session.command;
}

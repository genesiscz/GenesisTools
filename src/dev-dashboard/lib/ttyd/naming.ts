import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

/**
 * The subset of {@link TtydSession} the display-name derivation actually reads. Structural on
 * purpose: hub enrichment passes contract-shaped bindings that lack `pid`/`startedAt`.
 */
export type TtydNameSource = Pick<TtydSession, "name" | "tmuxSessionName" | "lastCommand" | "command" | "port">;

/**
 * Commands that are not meaningful as an auto-name — a session sitting at a shell prompt should fall
 * back to its tmux name / spawn command, not be labeled "zsh". Long-running foreground processes
 * (claude, vim, node, …) ARE meaningful, so anything not in this set becomes the auto-name when
 * there is no tmux binding.
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

function portFallback(session: TtydNameSource): string {
    return `${session.command.split("/").pop()} :${session.port}`;
}

/**
 * The display name for a ttyd session. Manual rename always wins; otherwise the **tmux session
 * name** is the shared identity with Session Hub (so tabs like `zsh :60586` never diverge from the
 * hub row). Meaningful foreground commands only auto-name when there is no tmux binding.
 *
 *   1. `name`            — explicit rename (tab pencil or hub rename). Sticky.
 *   2. `tmuxSessionName` — the bound tmux session (shared with Session Hub).
 *   3. `lastCommand`     — live foreground command, when meaningful and unbound.
 *   4. `command`:`port`  — spawn fallback.
 */
export function deriveTtydDisplayName(session: TtydNameSource): string {
    const manual = session.name?.trim();

    if (manual) {
        return manual;
    }

    const tmux = session.tmuxSessionName?.trim();

    if (tmux) {
        return tmux;
    }

    if (isMeaningfulCommand(session.lastCommand)) {
        return session.lastCommand.trim();
    }

    return portFallback(session);
}

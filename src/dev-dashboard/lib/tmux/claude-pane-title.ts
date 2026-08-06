/**
 * Claude Code sets the tmux pane title via OSC to `<marker> <name>`. Strip the marker so we can
 * mirror the name onto the tmux session + ttyd tab.
 *
 * The marker is `✳` while working, and otherwise an ANIMATED BRAILLE SPINNER FRAME — not a single
 * fixed glyph. Matching only `⠐` (U+2810) made the sync succeed or fail depending on which frame
 * happened to be current at poll time: a live session observed here read `⠂ ttyd-naming` (U+2802)
 * and parsed as null. Accept the whole Braille Patterns block (U+2800–U+28FF).
 *
 * @see src/cmux/docs/Cmux.md — same title convention on cmux surfaces.
 */
const CLAUDE_PANE_TITLE_RE = /^[✳*⠀-⣿]\s*(.+)$/u;

/** Stock title before the user runs `/rename` — never promote this to a session name. */
const CLAUDE_DEFAULT_TITLES = new Set(["claude code", "claude"]);

export function parseClaudePaneTitle(title: string | undefined | null): string | null {
    if (!title) {
        return null;
    }

    const trimmed = title.trim();

    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(CLAUDE_PANE_TITLE_RE);

    if (!match?.[1]) {
        return null;
    }

    // tmux session names cannot contain `:` or `.` — both are target-syntax separators.
    // tmux 3.6a even silently munges a renamed session's dots to `_`, which would desync
    // the stored binding name from the real session. Collapse whitespace; keep the rest.
    const name = match[1].replace(/[:.]/g, "-").replace(/\s+/g, " ").trim();

    if (!name || CLAUDE_DEFAULT_TITLES.has(name.toLowerCase())) {
        return null;
    }

    return name;
}

export function isClaudeForegroundCommand(command: string | undefined): boolean {
    if (!command) {
        return false;
    }

    const base = command.trim().split("/").pop()?.toLowerCase() ?? "";
    return base === "claude" || base === "claude-code";
}

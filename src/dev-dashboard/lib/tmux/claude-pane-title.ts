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

/**
 * The Claude topic as the user typed it. Marker extraction ONLY — punctuation is display
 * text and must survive: a topic of `Fix v1.2 bug` used to render as `Fix v1-2 bug`
 * because this shared the tmux-name sanitizer below, which also made a bound session
 * disagree with the UI's own fallback parse of the same title.
 */
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

    const topic = match[1].replace(/\s+/g, " ").trim();

    if (!topic || CLAUDE_DEFAULT_TITLES.has(topic.toLowerCase())) {
        return null;
    }

    return topic;
}

/**
 * Sanitize a topic for use as a tmux SESSION NAME. tmux names cannot contain `:` or `.` —
 * both are target-syntax separators, and tmux 3.6a silently munges a renamed session's dots
 * to `_`, which desyncs the stored binding name from the real session.
 */
export function tmuxSessionNameFromTopic(topic: string): string {
    return topic.replace(/[:.]/g, "-").replace(/\s+/g, " ").trim();
}

export function isClaudeForegroundCommand(command: string | undefined): boolean {
    if (!command) {
        return false;
    }

    const base = command.trim().split("/").pop()?.toLowerCase() ?? "";
    return base === "claude" || base === "claude-code";
}

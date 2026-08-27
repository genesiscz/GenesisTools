/** Harness blocks whose CONTENT is noise, not something the user typed. */
export const CLAUDE_HARNESS_TAGS = [
    "local-command-caveat",
    "local-command-stdout",
    "system-reminder",
    "task-notification",
    "command-name",
    "command-message",
    "command-args",
] as const;

const NOISE_BLOCKS = new RegExp(`<(${CLAUDE_HARNESS_TAGS.join("|")})>[\\s\\S]*?</\\1>`, "g");

/** Lines pasted from a terminal screenshot: the Claude Code status line. */
export const CLAUDE_STATUS_NOISE_LINES = [
    /bypass permissions/i,
    /\d+k\/\d+k\(/,
    /^\s*claude-[a-z]+-[\d.]/i,
    /for agents\s*$/,
];

const TITLE_MAX = 120;

export interface CleanTranscriptOptions {
    /** Keep `/speckit.implement` when the rest of the string is empty. Default true. */
    slashFallback?: boolean;
    /** Drop pasted status-line rows. Default false (envelope turns keep them). */
    dropStatusLines?: boolean;
}

function stripHarness(raw: string, opts: CleanTranscriptOptions): { text: string; commands: string[] } {
    const commands: string[] = [];
    for (const match of raw.matchAll(/<command-name>\s*([^<]+?)\s*<\/command-name>/gi)) {
        const name = match[1]?.trim();
        if (name) {
            commands.push(name.startsWith("/") ? name : `/${name}`);
        }
    }

    let text = raw
        .replace(/\[Image #\d+\]/g, " ")
        .replace(NOISE_BLOCKS, " ")
        .replace(/<\/?[a-z][\w-]*>/gi, " ");

    const lines = text.split("\n");
    const kept = opts.dropStatusLines
        ? lines.filter((line) => !CLAUDE_STATUS_NOISE_LINES.some((pattern) => pattern.test(line)))
        : lines;
    text = kept.join(" ").replace(/\s+/g, " ").trim();
    return { text, commands };
}

/** Envelope / last-user column. Never truncates. Empty string when only noise. */
export function cleanTranscriptText(raw: string, opts: CleanTranscriptOptions = {}): string {
    const { text, commands } = stripHarness(raw, opts);
    if (text) {
        return text;
    }
    if (opts.slashFallback === false) {
        return "";
    }
    return commands.join(" ");
}

/** Session titles and cmux tab names. Null when only noise. Caps at 120. */
export function cleanPromptText(raw: string | null | undefined): string | null {
    if (!raw) {
        return null;
    }
    const cleaned = cleanTranscriptText(raw, { dropStatusLines: true });
    if (!cleaned) {
        return null;
    }
    return cleaned.length > TITLE_MAX ? `${cleaned.slice(0, TITLE_MAX - 1)}…` : cleaned;
}

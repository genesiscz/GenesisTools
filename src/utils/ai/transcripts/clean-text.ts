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
    /** Keep `/rename board-polish` when the rest of the string is empty. Default true. */
    slashFallback?: boolean;
    /** Drop pasted status-line rows. Default false (envelope turns keep them). */
    dropStatusLines?: boolean;
}

/** One slash-command invocation as the harness records it. `args` is "" when the user typed none. */
export interface SlashInvocation {
    name: string;
    args: string;
}

/**
 * Every `<command-name>` in the text, paired with the `<command-args>` that follows it.
 *
 * The args are read from the span between this command name and the next one, so a turn that
 * carries several invocations keeps each one's arguments with the right command.
 */
export function extractSlashInvocations(raw: string): SlashInvocation[] {
    const matches = [...raw.matchAll(/<command-name>\s*([^<]+?)\s*<\/command-name>/gi)];
    const invocations: SlashInvocation[] = [];

    for (const [index, match] of matches.entries()) {
        const name = match[1]?.trim();
        if (!name) {
            continue;
        }
        const from = (match.index ?? 0) + match[0].length;
        const to = index + 1 < matches.length ? (matches[index + 1].index ?? raw.length) : raw.length;
        const args = /<command-args>([\s\S]*?)<\/command-args>/i
            .exec(raw.slice(from, to))?.[1]
            ?.replace(/\s+/g, " ")
            .trim();

        invocations.push({ name: name.startsWith("/") ? name : `/${name}`, args: args ?? "" });
    }

    return invocations;
}

/**
 * True when the text is nothing but slash commands the user typed no arguments for.
 *
 * `/clear`, `/compact`, `/model` and friends are harness plumbing: the turn carries none of the
 * user's own words, so showing it as a session's name says nothing about what the session is.
 * A command WITH arguments (`/rename board-polish`) does carry them and is kept.
 */
export function isBareSlashCommandText(raw: string): boolean {
    const { text, commands } = stripHarness(raw, { dropStatusLines: true });

    return !text && commands.length > 0 && commands.every((command) => !command.args);
}

function stripHarness(raw: string, opts: CleanTranscriptOptions): { text: string; commands: SlashInvocation[] } {
    const commands = extractSlashInvocations(raw);

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
    // A command the user typed no arguments for is dropped, not named: see isBareSlashCommandText.
    return commands
        .filter((command) => command.args)
        .map((command) => `${command.name} ${command.args}`)
        .join(" ");
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

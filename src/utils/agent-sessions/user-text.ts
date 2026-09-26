import { isBareSlashCommandText } from "@genesiscz/utils/ai/transcripts/clean-text";

/**
 * Codex and Grok wrap machine-generated context in a leading tag and send it as a user-role
 * message. Treating one as the session's own first prompt made 48 of 111 Codex sessions on this
 * machine list `<environment_context> <cwd>/Users/…` where the user's words belong. Three readers
 * each carried a different partial list of these prefixes; this is the union of all three.
 */
const WRAPPER_PREFIXES = [
    "# AGENTS.md",
    "<user_info>",
    "<user_instructions>",
    "<environment_context>",
    "<git_status>",
    "<turn_aborted>",
    // Claude Code's own plumbing, measured over the 1,588 indexed sessions that carry a first
    // prompt: 97 open with the caveat block, 32 with a teammate message, 9 with a session-naming
    // reminder and 9 with a compaction header. That is 147 listings showing machinery.
    "<local-command-caveat>",
    "<teammate-message",
    "<system-reminder>",
    "## Context Usage",
    // What the harness delivers into a running session as a user turn: a peer's message and a
    // background task's result. A handoff quoted a whole teammate report as the session's goal.
    "Another Claude session sent a message",
    "<task-notification>",
    "[SYSTEM NOTIFICATION",
    // Claude Code's marker for an Esc, stored as a user turn.
    "[Request interrupted by user",
] as const;

// A slash command WITH arguments is kept: `/rename board-polish` is the user's own text, and the
// command name reads better in a listing than the turn that happens to follow it. A command with
// no arguments (`/clear`, `/compact`, `/model`) is dropped instead, because it names the harness
// rather than the work: sessions were listing `/clear` where the first real prompt belongs.

const NOISE_BLOCKS =
    /<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*?<\/\1>/gi;
const ANY_TAG = /<\/?[A-Za-z][\w-]*[^>]*>/g;
const IMAGE_MARK = /\[Image #\d+\]/g;

/**
 * A session title fit for a listing: the stored title is the first prompt, harness tags and all
 * (`<pasted_content id="b643"> 3) Restock…` in the hub's digest). Mirrors the app's
 * `TitleFormatter.cleanSessionTitle`: noise blocks go with their contents, any other tag goes but
 * its text stays. null when nothing readable is left.
 */
export function cleanSessionTitle(raw: string | null | undefined): string | null {
    if (!raw) {
        return null;
    }

    const text = raw
        .replace(IMAGE_MARK, " ")
        .replace(NOISE_BLOCKS, " ")
        .replace(ANY_TAG, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text || null;
}

export function isWrapperUserText(text: string): boolean {
    const trimmed = text.trimStart();

    if (WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
        return true;
    }

    return isBareSlashCommandText(trimmed);
}

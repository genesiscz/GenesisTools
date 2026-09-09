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
] as const;

// Deliberately NOT filtered: `<command-message>`. The user really did invoke that slash command,
// and the command's name is more use in a listing than whatever text happens to follow it.

export function isWrapperUserText(text: string): boolean {
    const trimmed = text.trimStart();

    return WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

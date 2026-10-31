import { type CmuxAdapter, SPINNER_PREFIX } from "../session-agents";

/** Claude draws a spinner glyph in front of the session title and ` · <id>` after it. */
function stripClaudeGlyph(title: string): string {
    return title
        .replace(SPINNER_PREFIX, "")
        .replace(/\s+·\s+[0-9a-f]{7,8}\s*$/i, "")
        .trim();
}

/** Claude's cmux part: its run door takes `--cross-messages` (the peer channel), and it starts with no trust prompt. */
export const cmuxPart: CmuxAdapter = {
    crossMessages: true,
    launchExtras: null,
    stripTitle: stripClaudeGlyph,
    trustPrompt: null,
};

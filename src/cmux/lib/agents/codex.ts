import type { CmuxAdapter } from "../session-agents";

function stripCodexSuffix(title: string): string {
    return title.replace(/\s+-\s+codex(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

/** Codex's cmux part: no peer channel, no launch extras, and no trust prompt this restore recognises. */
export const cmuxPart: CmuxAdapter = {
    crossMessages: false,
    launchExtras: null,
    stripTitle: stripCodexSuffix,
    trustPrompt: null,
};

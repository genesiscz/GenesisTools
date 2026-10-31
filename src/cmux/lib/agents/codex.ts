import { type CmuxAdapter, harnessSuffixStripper } from "../session-agents";

const stripCodexSuffix = harnessSuffixStripper("codex");

/** Codex's cmux part: no peer channel, no launch extras, and no trust prompt this restore recognises. */
export const cmuxPart: CmuxAdapter = {
    crossMessages: false,
    launchExtras: null,
    stripTitle: stripCodexSuffix,
    trustPrompt: null,
};

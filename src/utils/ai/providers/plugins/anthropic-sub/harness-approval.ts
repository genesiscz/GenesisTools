import type { ApprovalKeyMap } from "@genesiscz/utils/agents/approvals/keys";

/**
 * Measured live on 2026-11-04 14:56 to 15:09 (Claude Code 2.1.314, Haiku, a scratch session in a private tmux server,
 * manual mode; the lane report 2026-11-04-Mobile-P9-P10A.md has the screens).
 *
 * Permission dialog ("Do you want to proceed?"): 1. Yes / 2. Yes, and don't ask again for: <rule> / 3. Yes, and switch
 * to auto mode / 4. No. The third row is not always there, so No is not a fixed digit.
 * - A digit typed as text picks and submits its row in one press (`1` ran the command).
 * - Esc denies: the tool result says the user does not want to proceed, and the turn stops.
 * - Up on row 1 wraps to the last row (No); Tab turns that row into "No, and tell Claude what to do differently";
 *   typed text then Enter denies with the text, which the agent reads, and the turn goes on.
 *
 * Plan dialog ("Would you like to proceed?"): 1. Yes, and switch to BYPASS PERMISSIONS / 2. Yes, manually approve
 * edits / 3. Tell Claude what to change. `2` approved and left plan mode; `3` only moves to the text row, then text
 * and Enter send the feedback and Claude writes a new plan. Row 1 changes the whole session's permission mode, so
 * "allow always" is refused here rather than pressed.
 */
export const claudeApproval: ApprovalKeyMap = {
    permission: {
        supported: true,
        allow: [{ text: "1" }],
        allowAlways: [{ text: "2" }],
        deny: [{ key: "escape" }],
        denyWithReason: (reason) => [{ key: "up" }, { key: "tab" }, { text: reason }, { key: "enter" }],
    },
    plan: {
        supported: true,
        allow: [{ text: "2" }],
        allowAlways: {
            refused:
                "the plan dialog's only other yes switches the whole session to bypass permissions; choose it in the terminal",
        },
        deny: [{ text: "3" }, { text: "Do not proceed with this plan." }, { key: "enter" }],
        denyWithReason: (reason) => [{ text: "3" }, { text: reason }, { key: "enter" }],
    },
};

import type { DialogKeyMap } from "@genesiscz/utils/agents/dialogs/keys";

/**
 * Measured live on 2026-10-30 21:51 to 21:53 (Claude Code 2.1.314, Haiku, a scratch session in a background cmux
 * tab; the notes vault's Dev/Agents/DecisionDetection.md, section 2026-10-30 22:07). In the AskUserQuestion dialog:
 *
 * - The digit of an option, typed as text, picks that option AND submits it in one press, wherever the highlight is
 *   ("2" with the highlight on option 3 answered option 2). `cmux send-key 2` is refused ("Unknown key").
 * - Down and `j` move the highlight one row; Up and `k` move it back. Up on the first row wraps to "Type something.",
 *   Down stops on the last row ("Chat about this"). Tab and Home change nothing. Enter submits the highlighted row.
 * - With the highlight on "Chat about this" (a text row), a digit does nothing.
 * - A dialog with several questions takes one digit per question, then a review screen ("1. Submit answers").
 *
 * So the digit is the press: one key, independent of where the highlight is, and no Enter. When the dialog is
 * already gone, the digit stays in the prompt as one unsent character, while Enter would submit the prompt.
 */
export const claudeDialog: DialogKeyMap = {
    supported: true,
    select: (index) => [{ text: String(index + 1) }],
    maxOptions: 9,
};

import type { DialogProvider, OpenQuestion } from "./types";

/** One key press for a pane: a named key (`cmux send-key`) or a character typed as text (`cmux send`). */
export type DialogKeyPress = { key: string } | { text: string };

/** The keys that pick an option in a harness's question dialog, or why this harness has none yet. */
export type DialogKeyMap =
    | {
          supported: true;
          /** The presses that pick the 0-based option `index` of a one-question dialog and submit it. */
          select: (index: number) => DialogKeyPress[];
          /** The highest option count the keys can reach. */
          maxOptions: number;
      }
    | { supported: false; reason: string };

/**
 * Measured live on 2026-10-30 21:51 to 21:53 (Claude Code 2.1.314, Haiku, a scratch session in a background cmux
 * tab; GenesisBrain Dev/Agents/DecisionDetection.md, section 2026-10-30 21:58). In the AskUserQuestion dialog:
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
const CLAUDE_KEYS: DialogKeyMap = {
    supported: true,
    select: (index) => [{ text: String(index + 1) }],
    maxOptions: 9,
};

/**
 * The option keys per harness. A harness whose dialog keys were not measured live says so; its answers then go as
 * typed text through the normal delivery, which the dialog guard refuses while its dialog is open.
 */
export const DIALOG_KEY_MAPS: Record<DialogProvider, DialogKeyMap> = {
    claude: CLAUDE_KEYS,
    codex: {
        supported: false,
        reason: "the keys of the Codex request_user_input dialog were not measured live yet; answer it in the terminal",
    },
    grok: {
        supported: false,
        reason: "the keys of the Grok ask_user_question dialog were not measured live yet; answer it in the terminal",
    },
};

/** The letters of `count` options: a) b) c) and so on. */
export function optionLetters(count: number): string[] {
    return Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
}

/** The 0-based option an answer names: a letter (`b`) or a 1-based position (`2`); null for anything else. */
export function optionIndexOf(option: string): number | null {
    const value = option.trim().toLowerCase().replace(/\)$/, "");

    if (/^[a-z]$/.test(value)) {
        return value.charCodeAt(0) - 97;
    }

    if (/^[1-9]$/.test(value)) {
        return Number(value) - 1;
    }

    return null;
}

export type DialogKeyPlan =
    | { ok: true; presses: DialogKeyPress[]; index: number; label: string }
    | { ok: false; reason: string };

/**
 * The key presses that answer the open `question` with `option`, or why they cannot. Refuses a question without
 * options (a plan approval, a permission prompt), a dialog with several questions (one option cannot answer it), an
 * option past the list, and a harness whose keys are unknown.
 */
export function planDialogKeys(question: OpenQuestion, option: string): DialogKeyPlan {
    const keys = DIALOG_KEY_MAPS[question.provider];

    if (!keys.supported) {
        return { ok: false, reason: keys.reason };
    }

    const options = question.options ?? [];

    if (question.kind !== "decision" || options.length === 0) {
        return { ok: false, reason: "the open dialog lists no options to pick; answer it in the terminal" };
    }

    if ((question.questionCount ?? 1) > 1) {
        return {
            ok: false,
            reason: `the open dialog asks ${question.questionCount} questions, and one option answers only the first; answer it in the terminal`,
        };
    }

    const index = optionIndexOf(option);
    const letters = optionLetters(Math.min(options.length, keys.maxOptions));

    if (index === null || index >= letters.length) {
        return {
            ok: false,
            reason: `option "${option}" is not in the dialog; its options are ${letters.map((letter, at) => `${letter}) ${options[at]}`).join(", ")}`,
        };
    }

    return { ok: true, presses: keys.select(index), index, label: options[index] ?? "" };
}

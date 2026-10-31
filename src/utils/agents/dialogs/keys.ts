import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import type { DialogProvider, OpenQuestion } from "./types";

/** One key press for a pane: a named key (`cmux send-key`) or a character typed as text (`cmux send`). */
export type DialogKeyPress = { key: string } | { text: string };

/** The keys that pick an option in a harness's question dialog: its driver's `dialog` part. */
export interface DialogKeys {
    /** The presses that pick the 0-based option `index` of a one-question dialog and submit it. */
    select: (index: number) => DialogKeyPress[];
    /** The highest option count the keys can reach. */
    maxOptions: number;
}

/** The keys that pick an option in a harness's question dialog, or why this harness has none yet. */
export type DialogKeyMap = ({ supported: true } & DialogKeys) | { supported: false; reason: string };

/**
 * The option keys of a harness: its driver's `dialog` part. A harness whose dialog keys were not measured live says so
 * with `supported: false` and a reason; its answers then go as typed text through the normal delivery, which the
 * dialog guard refuses while its dialog is open.
 */
export function dialogKeysOf(provider: DialogProvider): DialogKeyMap {
    return harnessDriver(provider).parts.dialog;
}

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
    const keys = dialogKeysOf(question.provider);

    if (!keys.supported) {
        return { ok: false, reason: keys.reason };
    }

    const options = question.options ?? [];

    if (question.kind !== "decision" || options.length === 0) {
        return { ok: false, reason: "the open dialog lists no options to pick; answer it in the terminal" };
    }

    if (question.questionCount === undefined) {
        return { ok: false, reason: "the dialog question count is unknown; answer it in the terminal" };
    }

    if (question.questionCount > 1) {
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

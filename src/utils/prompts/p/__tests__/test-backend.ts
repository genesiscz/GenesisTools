import { promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import type { PromptBackend } from "@genesiscz/utils/prompts/p";

/**
 * Give this as an answer to cancel that prompt, as Escape does. The facade then follows the call's `cancel` option:
 * "back" hands the cancel symbol to the caller, the default "exit" throws PromptCancelledError (a test never exits).
 */
export const CANCEL_ANSWER = promptCancelSymbol;

function orCancel<T>(value: unknown, read: (value: unknown) => T): T | symbol {
    return value === promptCancelSymbol ? promptCancelSymbol : read(value);
}

/**
 * A simple test backend that returns pre-canned answers for each prompt type.
 *
 * Keys in `answers` map:
 *   - "text"        → string returned by text()
 *   - "confirm"     → boolean returned by confirm()
 *   - "typedConfirm"→ boolean returned by typedConfirm()
 *   - "select"      → value returned by select()
 *   - "multiselect" → array returned by multiselect()
 *   - "password"    → string returned by password()
 *
 * For sequential calls of the same type, use indexed keys:
 *   - "text.0", "text.1", … (falls back to "text" when index key not found)
 *
 * Any answer may be CANCEL_ANSWER, which cancels that prompt.
 */
export function makeTestBackend(answers: Record<string, unknown> = {}): PromptBackend {
    const counters: Record<string, number> = {};

    function next(key: string): unknown {
        const idx = counters[key] ?? 0;
        counters[key] = idx + 1;
        const indexedKey = `${key}.${idx}`;
        return indexedKey in answers ? answers[indexedKey] : answers[key];
    }

    return {
        intro: () => {},
        outro: () => {},
        cancel: () => {},
        note: () => {},

        text: async () => orCancel(next("text"), (v) => (v as string) ?? ""),
        confirm: async () => orCancel(next("confirm"), (v) => (v as boolean) ?? false),
        typedConfirm: async () => orCancel(next("typedConfirm"), (v) => (v as boolean) ?? true),
        select: async <V>() => orCancel(next("select"), (v) => v as V),
        multiselect: async <V>() => orCancel(next("multiselect"), (v) => (v as V[]) ?? []),
        password: async () => orCancel(next("password"), (v) => (v as string) ?? ""),

        // Canonical PromptBackend methods added in COS-T2 (Agent B); their
        // test stubs were deferred to the integrator since Agent A's
        // inquirer-backend was being written in parallel.
        search: async <T>() => orCancel(next("search"), (v) => v as T),
        editor: async () => orCancel(next("editor"), (v) => (v as string) ?? ""),
        number: async () => orCancel(next("number"), (v) => (v as number) ?? 0),

        spinner: () => ({
            start: () => {},
            stop: () => {},
            message: () => {},
        }),

        log: {
            info: () => {},
            success: () => {},
            warn: () => {},
            warning: () => {},
            error: () => {},
            step: () => {},
            message: () => {},
        },
    };
}

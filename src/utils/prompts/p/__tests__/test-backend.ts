import type { PromptBackend, SelectValue } from "@app/utils/prompts/p";

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

        text: async () => (next("text") as string) ?? "",
        confirm: async () => (next("confirm") as boolean) ?? false,
        typedConfirm: async () => (next("typedConfirm") as boolean) ?? true,
        select: async () => next("select") as SelectValue,
        multiselect: async () => ((next("multiselect") as SelectValue[]) ?? []),
        password: async () => (next("password") as string) ?? "",

        // Canonical PromptBackend methods added in COS-T2 (Agent B); their
        // test stubs were deferred to the integrator since Agent A's
        // inquirer-backend was being written in parallel.
        search: async <T>() => (next("search") as T),
        editor: async () => (next("editor") as string) ?? "",
        number: async () => (next("number") as number) ?? 0,

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

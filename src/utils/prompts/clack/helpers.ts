/**
 * Helpers for @clack/prompts
 */
import * as p from "@clack/prompts";
import { exitCancelled, promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import pc from "picocolors";
import { inputCancelSymbol } from "./input";

/**
 * Check if a value is a cancel symbol (user pressed Escape/Ctrl+C).
 * Detects clack's internal cancel symbol, the light-mode inputCancelSymbol and the facade's promptCancelSymbol.
 */
export function isCancelled(value: unknown): value is symbol {
    return p.isCancel(value) || value === inputCancelSymbol || value === promptCancelSymbol;
}

/**
 * Handle cancellation with consistent messaging and exit (inside a test it throws PromptCancelledError instead)
 */
export function handleCancel(message = "Operation cancelled"): never {
    exitCancelled((text) => p.cancel(text), message);
}

/**
 * Wrapper for prompts that handles cancellation automatically
 */
export async function withCancel<T>(promptResult: Promise<T | symbol>, cancelMessage?: string): Promise<T> {
    const result = await promptResult;
    if (isCancelled(result)) {
        handleCancel(cancelMessage);
    }
    return result as T;
}

/**
 * Enhanced multiselect with hint for keyboard usage
 */
export async function multiselect<T extends p.Option<unknown>>(
    opts: Omit<p.MultiSelectOptions<T>, "message"> & { message: string }
): Promise<T["value"][] | symbol> {
    return p.multiselect({
        ...opts,
        message: `${opts.message} ${pc.dim("(space to toggle)")}`,
    });
}

/**
 * Spinner wrapper
 */
export function spinner() {
    return p.spinner();
}

/**
 * Log utilities - re-export from clack
 */
export const log = p.log;

/**
 * Session management - re-export from clack
 */
export const intro = p.intro;
export const outro = p.outro;
export const cancel = p.cancel;
export const note = p.note;

/**
 * Prompts - re-export from clack
 */
export const select = p.select;
export const text = p.text;
export const confirm = p.confirm;
export const password = p.password;
export const isCancel = p.isCancel;

// Re-export clack prompts and picocolors
export { p, pc };

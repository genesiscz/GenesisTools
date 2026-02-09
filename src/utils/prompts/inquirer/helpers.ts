/**
 * Helpers for @inquirer/prompts
 */
import { ExitPromptError } from "@inquirer/core";

/**
 * Check if error is a user cancellation (Ctrl+C / Escape)
 */
export function isUserCancellation(error: unknown): error is ExitPromptError {
    return error instanceof ExitPromptError;
}

/**
 * Wrap an async function to handle ExitPromptError gracefully
 */
export async function withCancellationHandling<T>(fn: () => Promise<T>, onCancel?: () => void): Promise<T | undefined> {
    try {
        return await fn();
    } catch (error) {
        if (isUserCancellation(error)) {
            onCancel?.();
            return undefined;
        }
        throw error;
    }
}

/**
 * Run a prompt and exit gracefully on cancellation
 */
export async function runPrompt<T>(promptFn: () => Promise<T>, exitMessage = "Operation cancelled"): Promise<T> {
    try {
        return await promptFn();
    } catch (error) {
        if (isUserCancellation(error)) {
            console.log(`\n${exitMessage}`);
            process.exit(0);
        }
        throw error;
    }
}

// Re-export for convenience
export { ExitPromptError } from "@inquirer/core";

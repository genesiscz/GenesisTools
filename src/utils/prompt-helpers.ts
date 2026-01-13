import { ExitPromptError } from "@inquirer/core";

/**
 * Handle prompt cancellation (Ctrl+C or Escape).
 * Logs a message and exits the process.
 */
export function handlePromptCancel(error: unknown): never {
    if (error instanceof ExitPromptError) {
        console.log("\nOperation cancelled.");
        process.exit(0);
    }
    throw error;
}

/**
 * Check if error is a prompt cancellation.
 * Returns true for ExitPromptError (new @inquirer/prompts)
 * and for Enquirer's "canceled" message (legacy support).
 */
export function isPromptCancelled(error: unknown): boolean {
    if (error instanceof ExitPromptError) {
        return true;
    }
    // Legacy Enquirer support
    if (error instanceof Error && error.message === "canceled") {
        return true;
    }
    return false;
}

// Re-export for convenience
export { ExitPromptError } from "@inquirer/core";

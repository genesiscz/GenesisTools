/**
 * A user who cancels a prompt (Ctrl-C, Escape) has not hit a failure. `runTool` asks `isPromptCancel` before it
 * reports an error, so a cancelled command exits 0 and prints nothing.
 */
export class PromptCancelledError extends Error {
    constructor(message = "Cancelled") {
        super(message);
        this.name = "PromptCancelledError";
    }
}

/** A user cancel in any form: the class above, inquirer's ExitPromptError, or the old Error("Cancelled"). */
export function isPromptCancel(error: unknown): boolean {
    if (error instanceof PromptCancelledError) {
        return true;
    }

    if (!(error instanceof Error)) {
        return false;
    }

    // By name, not `instanceof`: importing @inquirer/core here would load it into every tool's start.
    return error.name === "ExitPromptError" || error.message === "Cancelled";
}

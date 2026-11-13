import { env } from "@genesiscz/utils/env";

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

/**
 * The answer every facade backend gives for a cancelled prompt. A prompt called with `cancel: "back"` hands it to
 * its caller, where `p.isCancel` recognizes it; with the default `cancel: "exit"` the facade never lets it out.
 */
export const promptCancelSymbol: unique symbol = Symbol.for("genesis-tools:prompt-cancel");

/**
 * The default cancel outcome of a facade prompt: print the cancel message and end the process with exit code 0. Inside
 * a test it throws `PromptCancelledError` instead, so a test can assert the exit outcome without losing its process.
 */
export function exitCancelled(write: (message: string) => void, message = "Operation cancelled"): never {
    if (env.node.getEnv() === "test") {
        throw new PromptCancelledError(message);
    }

    write(message);
    process.exit(0);
}

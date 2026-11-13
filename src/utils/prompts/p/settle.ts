import { exitCancelled, promptCancelSymbol } from "@genesiscz/utils/prompts/cancel";
import { getBackend } from "./backend";
import type { CancelOutcome } from "./types";

/**
 * The one cancel policy of every facade prompt (p/index.ts and `out`'s prompts). A cancelled answer goes back to the
 * caller only when the call asked for `cancel: "back"`; otherwise the active backend prints the cancel message and the
 * process ends with code 0. No clack import here, so `out` keeps its lazy load of @clack/prompts.
 */
export function settle<T>(answer: T | symbol, cancel: CancelOutcome | undefined): T | symbol {
    if (cancel === "back" || answer !== promptCancelSymbol) {
        return answer;
    }

    const backend = getBackend();
    exitCancelled((message) => backend.cancel(message));
}

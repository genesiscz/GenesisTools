import { AsyncLocalStorage } from "node:async_hooks";
import { effectLabel, type MethodDescriptor, type MethodReach } from "./descriptor";

/** The described method a call runs inside: the REPL binding opens one per call. */
interface MethodScope {
    /** `movies.Movie.find` */
    name: string;
    method: Pick<MethodDescriptor, "effect" | "reaches">;
}

const scope = new AsyncLocalStorage<MethodScope>();

/** Runs `run` as the call of one described method, so `assertReach()` below it can check the declaration. */
export function runInMethodScope<T>(call: MethodScope, run: () => T): T {
    return scope.run(call, run);
}

/** A described method tried to reach the user or spend money without declaring it. Nothing was started. */
export class UndeclaredReachError extends Error {
    override name = "UndeclaredReachError";
}

/**
 * Put immediately before the line that prompts the user or starts a paid run. Inside a described call that does
 * not declare `reach`, it throws, so a method declared `read` can never start a transcription or a dialog; outside
 * every described call (a CLI command a person runs) it allows the action.
 */
export function assertReach(reach: MethodReach, action: string, instead?: string): void {
    const call = scope.getStore();

    if (!call || (call.method.reaches ?? []).includes(reach)) {
        return;
    }

    throw new UndeclaredReachError(
        `${call.name} is declared [${effectLabel(call.method)}], so it may not ${action} (that reaches: ${reach}); nothing was started.${instead ? ` ${instead}` : ""}`
    );
}

// Helpers for the second half of the loop_test.go twins (`coordinator.loop-b.test.ts`) that
// `driver.ts` does not have yet:
//
// - `DirectRun`: drives `current.Run(ctx)` on a coordinator built by `newTestCoordinator*`,
//   standing in for the Go `go func() { done <- current.Run(ctx) }()` plus `receiveTestValue`.
// - The Go white-box calls (`addOperationToLocalState`, `addToolCallsToLocalState`,
//   `storeItemInSessionStore`, `closedInputError`) with a `Coordinator` receiver, forwarded to the
//   typed `CoordinatorInternals`.
// - `errorChainIncludes` / `errorChainHas`: `errors.Is` over the `cause` chain.
// - `MutatingOperationManager`: the `mutateAdds` switch of the Go `fakeOperationManager`.

import { drainTasks, VirtualClock } from "../clock";
import { type Coordinator, coordinatorInternals, SLURP_IDLE_MS } from "../coordinator";
import type { Operation } from "../operation";
import type { Item, ModelResponse } from "../sessionstore";
import { type DirectCoordinator, FakeOperationManager, type RunOutcome } from "./driver";

// ─────────────────────────────── running a direct coordinator ───────────────────────────────

function clockOf(direct: DirectCoordinator): VirtualClock {
    const clock = direct.deps.clock;

    if (!(clock instanceof VirtualClock)) {
        throw new Error("direct coordinator does not run on a VirtualClock");
    }

    return clock;
}

export class DirectRun {
    readonly controller = new AbortController();
    readonly done: RunOutcome = { settled: false, error: undefined };

    constructor(readonly direct: DirectCoordinator) {}

    /** `go func() { done <- current.Run(ctx) }()`. */
    async start(signal: AbortSignal = this.controller.signal): Promise<void> {
        this.direct.current.run(signal).then(
            () => {
                this.done.settled = true;
            },
            (error: unknown) => {
                this.done.settled = true;
                this.done.error = error;
            }
        );
        await drainTasks();
    }

    /** `synctest.Wait(); synctest.Sleep(2 * slurpIdleTimeout); synctest.Wait()`. */
    async settle(): Promise<void> {
        await this.sleep(2 * SLURP_IDLE_MS);
    }

    /** `time.Sleep(ms)` on the virtual clock. */
    async sleep(ms: number): Promise<void> {
        await drainTasks();
        await clockOf(this.direct).advance(ms);
        await drainTasks();
    }

    cancel(reason?: unknown): void {
        this.controller.abort(reason);
    }

    /** `receiveTestValue(t, done)`: the error `Run` returned (undefined for nil); throws if it has not returned. */
    async result(): Promise<unknown> {
        for (let round = 0; round < 10 && !this.done.settled; round++) {
            await this.settle();
        }

        if (!this.done.settled) {
            throw new Error("timed out waiting for Run to return");
        }

        return this.done.error;
    }
}

/** `current.Run(ctx)` called synchronously: start it and wait until it returns. */
export async function runToEnd(direct: DirectCoordinator, signal?: AbortSignal): Promise<unknown> {
    const run = new DirectRun(direct);
    await run.start(signal);
    return run.result();
}

// ─────────────────────────────── errors ───────────────────────────────

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `errors.Is(err, want)`: `want` is `err` or somewhere on its `cause` chain. */
export function errorChainIncludes(error: unknown, want: unknown): boolean {
    return errorChainHas(error, (link) => link === want);
}

export function errorChainHas(error: unknown, predicate: (link: unknown) => boolean): boolean {
    const seen = new Set<unknown>();
    let link: unknown = error;

    while (link !== undefined && link !== null && !seen.has(link)) {
        if (predicate(link)) {
            return true;
        }

        seen.add(link);
        link = link instanceof Error ? link.cause : undefined;
    }

    return false;
}

// ─────────────────────────────── private coordinator methods ───────────────────────────────

/** Go `current.addOperationToLocalState(value)`. */
export function addOperationToLocalState(current: Coordinator, operation: Operation): Operation {
    return coordinatorInternals(current).addOperationToLocalState(operation);
}

/** Go `current.addToolCallsToLocalState(response)`. */
export function addToolCallsToLocalState(current: Coordinator, response: ModelResponse): void {
    coordinatorInternals(current).addToolCallsToLocalState(response);
}

/** Go `current.storeItemInSessionStore(ctx, item)`. */
export async function storeItemInSessionStore(current: Coordinator, item: Item): Promise<void> {
    await coordinatorInternals(current).storeItemInSessionStore(item);
}

/** Go `closedInputError(ctx, name)`; in the port it is a method, not a package function. */
export function closedInputError(current: Coordinator, signal: AbortSignal, name: string): Error {
    return coordinatorInternals(current).closedInputError(signal, name);
}

// ─────────────────────────────── fakes ───────────────────────────────

/**
 * The Go `fakeOperationManager` with `mutateAdds` set. Go overwrites the first byte of the
 * `State` and `Idempotency` slices it receives; TypeScript strings are immutable, so the same
 * aliasing hazard is a manager reassigning those fields on the object it was handed.
 */
export class MutatingOperationManager extends FakeOperationManager {
    mutateAdds = false;

    override add(operation: Operation): void {
        this.adds.push(operation);

        if (this.mutateAdds) {
            operation.State = `!${(operation.State ?? "").slice(1)}`;
            operation.Idempotency = `!${(operation.Idempotency ?? "").slice(1)}`;
        }

        const error = this.addError?.(operation);

        if (error) {
            throw error;
        }
    }
}

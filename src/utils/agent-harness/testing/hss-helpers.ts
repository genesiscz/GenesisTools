// Helpers for the heartbeat, scheduling, submission and slurp twins that `driver.ts` does not
// carry: the Go `persistTestRun` / `restoreTestRun` pair (recovery_sequences_test.go), the
// `submissionFailureStore` and `submittingResultErrorTranslator` fakes, and `errors.Is`.

import { AbortedError } from "../clock";
import { SLURP_IDLE_MS } from "../coordinator";
import type { Input } from "../inbox";
import type { ToolResult } from "../llm";
import { MemoryStore, type ModelResponse, type ResumeState, type Store, type Turn } from "../sessionstore";
import { type StopTestRun, SubmittingTranslator } from "./driver";

/** Go's `context.Canceled`: the reason a twin cancels its run with, so `errors.Is` has a sentinel. */
export const contextCanceled = new AbortedError("context canceled");

/** `errors.Is(err, want)`: the error itself or any error on its `cause` chain. */
export function errorIs(error: unknown, want: unknown): boolean {
    let current: unknown = error;

    for (let depth = 0; depth < 32 && current !== undefined && current !== null; depth++) {
        if (current === want) {
            return true;
        }

        current = current instanceof Error ? current.cause : undefined;
    }

    return false;
}

/**
 * `err := <-run.done` (a blocking receive): inside a synctest bubble the clock jumps to the next
 * timer while every goroutine is blocked, so the receive waits out slurp idle windows. Here
 * that is advancing the virtual clock one slurp idle step at a time until the run settles.
 */
export async function awaitDone(run: StopTestRun, maxSteps = 1000): Promise<unknown> {
    for (let step = 0; step < maxSteps && !run.done.settled; step++) {
        await run.sleep(SLURP_IDLE_MS);
    }

    if (!run.done.settled) {
        throw new Error("Run did not return");
    }

    return run.done.error;
}

/**
 * `persistTestRun(t, run)`: copies the run's fixture history into a real store. Go uses a
 * `localfile.Store` in a temp dir; the file store is not ported, so this is `MemoryStore`.
 * Difference that does not reach these twins: `MemoryStore.resume` returns every operation,
 * localfile only the unfinished ones and terminal states missing from history. Restoring an
 * extra terminal state only re-sets local state history already holds, and a terminal
 * operation is never dispatched.
 */
export async function persistTestRun(run: StopTestRun): Promise<MemoryStore> {
    const store = new MemoryStore("session-1", () => "");
    const [turn, response, ...statuses] = run.store.items;

    if (turn?.Kind !== "turn" || response?.Kind !== "model_response") {
        throw new Error("fixture must start with a turn and its model response");
    }

    await store.appendTurn("session-1", turn.Data);
    await store.appendModelResponse("session-1", response.Data);

    for (const item of statuses) {
        if (item.Kind !== "tool_call_status") {
            throw new Error(`fixture item ${item.Sequence ?? 0} is not a tool call status`);
        }

        await store.appendToolCallStatus("session-1", item.Data);
    }

    return store;
}

/** `restoreTestRun(t, run, store)`: the run's sessions and restored state come from `store`. */
export async function restoreTestRun(run: StopTestRun, store: Store): Promise<void> {
    run.deps.restored = await store.resume("session-1");
    run.deps.sessions = store;
}

/** `submissionFailureStore`: a store whose input, turn and response appends can be made to fail. */
export class SubmissionFailureStore implements Store {
    inputErr: Error | null = null;
    turnErr: Error | null = null;
    responseErr: Error | null = null;

    constructor(readonly inner: Store) {}

    items(id: string, after: number, limit: number) {
        return this.inner.items(id, after, limit);
    }

    async appendInput(id: string, input: Input): Promise<void> {
        if (this.inputErr) {
            throw this.inputErr;
        }

        await this.inner.appendInput(id, input);
    }

    async appendTurn(id: string, turn: Turn): Promise<void> {
        if (this.turnErr) {
            throw this.turnErr;
        }

        await this.inner.appendTurn(id, turn);
    }

    async appendModelResponse(id: string, response: ModelResponse): Promise<void> {
        if (this.responseErr) {
            throw this.responseErr;
        }

        await this.inner.appendModelResponse(id, response);
    }

    appendToolCallStatus(...args: Parameters<Store["appendToolCallStatus"]>) {
        return this.inner.appendToolCallStatus(...args);
    }

    saveOperation(...args: Parameters<Store["saveOperation"]>) {
        return this.inner.saveOperation(...args);
    }

    resume(id: string): Promise<ResumeState> {
        return this.inner.resume(id);
    }
}

/** `submittingResultErrorTranslator`: submits like `submittingTranslator`, then fails every result. */
export class SubmittingResultErrorTranslator extends SubmittingTranslator {
    constructor(readonly error: Error) {
        super();
    }

    override translateResult(): ToolResult {
        throw this.error;
    }
}

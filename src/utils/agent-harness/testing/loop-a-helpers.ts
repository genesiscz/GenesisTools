// Helpers for the twins of the first half of harness/coordinator/loop_test.go
// (coordinator.loop-a.test.ts) that testing/driver.ts does not carry yet.

import { SafeJSON } from "@genesiscz/utils/json";
import type { AsyncQueue } from "../async-queue";
import { drainTasks, VirtualClock } from "../clock";
import { type CoordinatorInternals, SLURP_IDLE_MS } from "../coordinator";
import type { Item as Item2, Response } from "../llm";
import type { Item } from "../sessionstore";
import type { DirectCoordinator } from "./driver";
import { usage } from "./driver";

/** An `llm.Response{ID: id, Output: output}` literal: the zero stop reason is spelled "complete" here. */
export function modelResponse(output: Item2[], id = ""): Response {
    return { ID: id, Stop: "complete", Usage: usage(), Output: output };
}

export function virtualClock(direct: DirectCoordinator): VirtualClock {
    const clock = direct.deps.clock;

    if (!(clock instanceof VirtualClock)) {
        throw new Error("test coordinator has no virtual clock");
    }

    return clock;
}

export interface RunHandle {
    settled: boolean;
    error: unknown;
    promise: Promise<void>;
}

/** `go func() { done <- current.Run(ctx) }()`. */
export function startRun(direct: DirectCoordinator, signal: AbortSignal): RunHandle {
    const handle: RunHandle = { settled: false, error: undefined, promise: Promise.resolve() };
    handle.promise = direct.current.run(signal).then(
        () => {
            handle.settled = true;
        },
        (error) => {
            handle.settled = true;
            handle.error = error;
        }
    );
    return handle;
}

/**
 * `receiveTestValue(t, values)`: wait for the next value on a channel. Go waits up to one
 * real second; here virtual time moves one slurp window at a time, so no timer the test does
 * not expect (the one-second tool grace) can fire while waiting.
 */
export async function receiveTestValue<T>(clock: VirtualClock, values: AsyncQueue<T>, rounds = 50): Promise<T> {
    for (let round = 0; round < rounds; round++) {
        const value = values.tryTake();

        if (value !== undefined) {
            return value;
        }

        await drainTasks();
        await clock.advance(SLURP_IDLE_MS);
    }

    const value = values.tryTake();

    if (value === undefined) {
        throw new Error("timed out waiting for value");
    }

    return value;
}

/** `receiveTestValue(t, done)`: wait for the run to return and hand back its error. */
export async function receiveRunError(clock: VirtualClock, run: RunHandle, rounds = 50): Promise<unknown> {
    for (let round = 0; round < rounds && !run.settled; round++) {
        await drainTasks();
        await clock.advance(SLURP_IDLE_MS);
    }

    if (!run.settled) {
        throw new Error("timed out waiting for value");
    }

    return run.error;
}

/** `errors.Is(err, target)`: `err` is `target` or wraps it through `cause`. */
export function errorsIs(error: unknown, target: unknown): boolean {
    let current: unknown = error;

    for (let depth = 0; depth < 32 && current !== undefined && current !== null; depth++) {
        if (current === target) {
            return true;
        }

        current = current instanceof Error ? current.cause : undefined;
    }

    return false;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The message a synchronous call throws, or `null` when it returns. */
export function thrownMessage(fn: () => unknown): string | null {
    try {
        fn();
    } catch (error) {
        return errorMessage(error);
    }

    return null;
}

/** The message a promise rejects with, or `null` when it resolves. */
export async function rejectionMessage(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise;
    } catch (error) {
        return errorMessage(error);
    }

    return null;
}

export interface ToolCallStateEntry {
    toolCall: { CallID: string; Name: string; Arguments: string };
    status?: { Error: string; ErrorTruncated?: boolean; WaitingFor?: string[] };
    operations: string[];
}

/**
 * `current.state.toolCalls` as a map keyed `turnID/callID`, operations sorted, so a twin can
 * compare it with `toEqual` the way Go compares the map with `reflect.DeepEqual`.
 */
export function toolCallMap(internals: CoordinatorInternals): Record<string, ToolCallStateEntry> {
    const out: Record<string, ToolCallStateEntry> = {};

    for (const state of internals.toolCallStates()) {
        out[`${state.turnID}/${state.callID}`] = {
            toolCall: state.toolCall,
            ...(state.status ? { status: state.status } : {}),
            operations: [...state.operations].sort(),
        };
    }

    return out;
}

/**
 * A session item exactly as untyped JSON decodes it. Go's `Item.Data` is `any`, so a test can
 * store an input of an unknown kind or an item of an unknown kind; the port's `Item` is a
 * closed union, and the only way such a value reaches the coordinator is an unchecked decode
 * of persisted JSON. This helper is that decode, and nothing else.
 */
export function decodeUncheckedItem(json: string): Item {
    return SafeJSON.parse(json, { strict: true });
}

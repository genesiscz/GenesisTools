// Twins of harness/coordinator/slurp_test.go.
//
// Mapping: Go tests call `slurpChannel(ctx, output)` directly. The TS `slurp` is a private
// method reachable only through `run()`, so every twin drives the INBOX slurp through the loop:
//   - the channel is the inbox output queue (`run.inputs.outputQueue()`, an `AsyncQueue`);
//   - a "trigger" input is queued first, because the loop's select consumes one input before
//     `processEvents` slurps the rest, so the slurp sees exactly the values queued after it;
//   - the slurp's returned values are the inputs the store appends after the trigger
//     (`processInputs` runs only once the slurp returns), in order;
//   - `time.Since(startedAt)` is observed as the virtual time at which those appends land, and
//     the model request lands one more `SLURP_IDLE_MS` later (the operation-update slurp);
//   - `<-output` of the leftovers is `tryTake()` on the queue, before the loop reaches them;
//   - `close(output)` is aborting the inbox signal, which closes its output queue;
//   - `cancel(cause)` is aborting the run signal; the run returns `slurp inbox: <cause>`.
// Inputs are submitted without awaiting in between (`submitAll`), so they are all queued before
// the loop runs, as a buffered Go channel is filled before `slurpChannel` is called.

import { describe, expect, test } from "bun:test";
import { drainTasks } from "./clock";
import { SLURP_IDLE_MS } from "./coordinator";
import type { Input } from "./inbox";
import { externalEvent, newStopTestRun, oracle, type StopTestRun } from "./testing/driver";
import { errorIs } from "./testing/hss-helpers";

const NS = 1e-6;
const TRIGGER = "trigger";

function value(index: number | string): Input {
    return externalEvent(`value-${index}`, `value ${index}`);
}

async function submitAll(run: StopTestRun, inputs: Input[]): Promise<void> {
    await Promise.all(inputs.map((input) => run.inputs.submit(input)));
}

function appendedIDs(run: StopTestRun): string[] {
    return run.store.appendedInputs.map((input) => input.ID);
}

// Against the Go oracle time is real, and these twins order events at sub-millisecond distance
// around the 1 ms slurp idle window, which real timers cannot do: they stay port-only.
describe.skipIf(oracle)("slurp_test.go", () => {
    test("TestSlurpChannelPreservesOrder", async () => {
        for (const count of [0, 3]) {
            const run = newStopTestRun(0);
            await run.start();
            const want: string[] = [];
            const values: Input[] = [];

            for (let index = 0; index < count; index++) {
                values.push(value(index));
                want.push(`value-${index}`);
            }

            await submitAll(run, [externalEvent(TRIGGER, "trigger"), ...values]);
            await run.sleep(SLURP_IDLE_MS - NS);
            // slurp duration = %v, want %v (still collecting before the idle timeout)
            expect(appendedIDs(run), `count=${count}`).toEqual([TRIGGER]);
            await run.sleep(NS);
            // slurped values = %v, want %v
            expect(appendedIDs(run), `count=${count}`).toEqual([TRIGGER, ...want]);
            // The inbox slurp took exactly one idle interval: the update slurp that follows it
            // ends one more interval later, and only then does the model request start.
            await run.sleep(SLURP_IDLE_MS - NS);
            expect(run.requestCount(), `count=${count}`).toBe(0);
            await run.sleep(NS);
            expect(run.requestCount(), `count=${count}`).toBe(1);
            run.cancel();
        }
    });

    test("TestSlurpChannelResetsIdleTimeout", async () => {
        const run = newStopTestRun(0);
        await run.start();
        await submitAll(run, [externalEvent(TRIGGER, "trigger"), value(1)]);
        await run.sleep(SLURP_IDLE_MS / 2);
        await run.inputs.submit(value(2));
        await run.sleep(SLURP_IDLE_MS - NS);
        // slurp returned before a full idle interval after the last value
        expect(appendedIDs(run)).toEqual([TRIGGER]);
        await run.sleep(NS);
        // slurp did not return after a full idle interval
        // slurp result: values=%v error=%v
        expect(appendedIDs(run)).toEqual([TRIGGER, "value-1", "value-2"]);
        run.assertRunning();
        run.cancel();
    });

    test("TestSlurpChannelCapsBatch", async () => {
        for (const count of [99, 100, 101]) {
            const name = `count=${count}`;
            const run = newStopTestRun(0);
            await run.start();
            const want: string[] = [];
            const values: Input[] = [];

            for (let index = 0; index < count; index++) {
                values.push(value(index));
                want.push(`value-${index}`);
            }

            await submitAll(run, [externalEvent(TRIGGER, "trigger"), ...values]);
            await drainTasks();
            const batchSize = Math.min(count, 100);
            const queue = run.inputs.outputQueue();
            // remaining values = %d, want %d
            expect(queue.length, name).toBe(count - batchSize);

            for (const id of want.slice(batchSize)) {
                // remaining value = %d, want %d
                expect(queue.tryTake()?.ID, name).toBe(id);
            }

            if (count < 100) {
                // slurp duration = %v, want %v: a partial batch waits out one idle interval
                expect(appendedIDs(run), name).toEqual([TRIGGER]);
                await run.sleep(SLURP_IDLE_MS - NS);
                expect(appendedIDs(run), name).toEqual([TRIGGER]);
                await run.sleep(NS);
            }

            // slurped values = %v, want %v (a full batch returns with no time elapsed)
            expect(appendedIDs(run), name).toEqual([TRIGGER, ...want.slice(0, batchSize)]);
            run.cancel();
        }
    });

    test("TestSlurpChannelReturnsAccumulatedValuesOnClosure", async () => {
        for (const buffered of [false, true]) {
            const name = `buffered=${buffered}`;
            const run = newStopTestRun(0);
            await run.start();
            const inputs = [externalEvent(TRIGGER, "trigger")];
            const want: string[] = [];

            if (buffered) {
                inputs.push(externalEvent("second", "second"), externalEvent("third", "third"));
                want.push("second", "third");
            }

            await submitAll(run, inputs);
            run.inboxController.abort();
            const startedAt = run.clock.now();
            await drainTasks();
            // slurp result = %v, %v; want %v, nil
            expect(appendedIDs(run), name).toEqual([TRIGGER, ...want]);
            run.assertRunning();
            // closure advanced time by %v: the inbox slurp returned at once, so only the update
            // slurp's idle interval separates the trigger from the model request.
            await run.sleep(SLURP_IDLE_MS - NS);
            expect(run.requestCount(), name).toBe(0);
            await run.sleep(NS);
            expect(run.requestCount(), name).toBe(1);
            expect(run.clock.now() - startedAt, name).toBeCloseTo(SLURP_IDLE_MS, 9);
        }
    });

    test("TestSlurpChannelReturnsCancellationCause", async () => {
        const run = newStopTestRun(0);
        const controller = new AbortController();
        await run.start(controller.signal);
        const cause = new Error("session stopped");
        await run.inputs.submit(externalEvent(TRIGGER, "trigger"));
        await drainTasks();
        const startedAt = run.clock.now();
        controller.abort(cause);
        await drainTasks();
        // slurp error = %v, want %v
        expect(run.done.settled).toBe(true);
        expect(errorIs(run.done.error, cause)).toBe(true);
        expect(run.done.error instanceof Error ? run.done.error.message : run.done.error).toBe(
            "slurp inbox: session stopped"
        );
        // cancellation advanced time by %v
        expect(run.clock.now() - startedAt).toBe(0);
    });
});

// Twins of harness/coordinator/scheduling_test.go.
//
// Mapping: the Go tests that build their own coordinator over `independentToolCalls`, a test
// inbox, a fake operation manager and a recording adapter use `newStopTestRun(count)`, which is
// exactly that set with a virtual clock. `context.Canceled` is `contextCanceled`, passed to
// `run.cancel()`. A blocking `<-run.done` is `awaitDone(run)`; `select { case <-run.done: default: }`
// is `run.done.settled`. `independentToolCalls` and `assertCompletedResults` live in driver.ts.

import { describe, expect, test } from "bun:test";
import { coordinatorInternals, newCoordinator, SLURP_IDLE_MS } from "./coordinator";
import type { Operation } from "./operation";
import {
    assertCompletedResults,
    BASH_NAME,
    drainTasks,
    externalEvent,
    FakeAdapter,
    heartbeatInput,
    newRegistry,
    newStopTestRun,
    newToolGraceTestRun,
    newValueSpec,
    oracle,
    stopInput,
    textResponse,
    toolGraceResponse,
    updateToolGraceCall,
    usage,
} from "./testing/driver";
import { awaitDone, contextCanceled, errorIs, SubmittingResultErrorTranslator } from "./testing/hss-helpers";

describe("scheduling_test.go", () => {
    test("TestCoordinatorRunReturnsDispatchErrorForNewOperation", async () => {
        const run = newToolGraceTestRun();
        const want = new Error("dispatch failed");
        run.operations.addError = () => want;
        await run.start();
        await run.input(externalEvent("input", "run tool"));
        await run.respond(0, toolGraceResponse("A"));
        // Run did not return the dispatch error
        expect(run.done.settled).toBe(true);
        expect(errorIs(run.done.error, want)).toBe(true);
        // dispatch failure started another turn or failed to preserve the committed operation
        expect(run.calls).toHaveLength(1);
        expect(run.store.appendedStatuses).toHaveLength(1);
        expect(run.operations.adds).toHaveLength(1);
        // dispatched operation differs from its committed state
        expect(run.store.appendedStatuses[0].Operations).toEqual(run.operations.adds);
    });

    test("TestCoordinatorDispatchesOnlyNewToolOperations", async () => {
        const run = newToolGraceTestRun();
        await run.start();
        await run.input(externalEvent("first", "run tool"));
        await run.respond(0, toolGraceResponse("A"));
        await run.input(externalEvent("second", "run another tool"));
        await run.respond(1, toolGraceResponse("B"));
        await updateToolGraceCall(run, "A", "awaiting");
        await run.input(heartbeatInput("heartbeat"));
        await run.respond(2, textResponse("Waiting."));
        // operation dispatches = %#v, want each new operation once
        expect(run.operations.adds).toHaveLength(2);
        expect(run.operations.adds[0].ID).not.toBe(run.operations.adds[1].ID);
        await run.input(stopInput("stop", "when_idle"));
        await updateToolGraceCall(run, "A", "completed");
        await updateToolGraceCall(run, "B", "completed");
        await run.respond(3, textResponse("A completed."));
        await run.respond(4, textResponse("B completed."));
        run.assertStopped();
        // result delivery redispatched operations
        expect(run.operations.adds).toHaveLength(2);
    });

    test("TestCoordinatorSchedulingResultFailurePreventsDispatch", async () => {
        const run = newStopTestRun(0);
        const spec = newValueSpec("1");
        const want = new Error("cannot translate result");
        const translator = new SubmittingResultErrorTranslator(want);
        translator.specs = [spec];
        run.deps.tools = newRegistry({ Bash: translator }, BASH_NAME);
        const adapter = new FakeAdapter(async () => ({
            ID: "",
            Stop: "complete",
            Usage: usage(),
            Output: [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
        }));
        run.deps.llm = adapter;
        await run.start();
        await run.input(externalEvent("input", "run it"));
        // Run error = %v, want result translation error
        expect(errorIs(await awaitDone(run), want)).toBe(true);
        // model response was not persisted and translated
        expect(translator.calls).toHaveLength(1);
        expect(run.store.appendedResponses).toHaveLength(1);
        // failed result translation committed a status, dispatched work, or started another request
        expect(run.store.appendedStatuses).toHaveLength(0);
        expect(run.operations.adds).toHaveLength(0);
        expect(adapter.requests).toHaveLength(1);
    });

    // Go calls `current.reconcileToolCalls()` on a coordinator it built by hand: white-box, port only.
    test.skipIf(oracle)("TestCoordinatorReconciliationRejectsUntranslatedCall", async () => {
        const run = newStopTestRun(1);
        run.store.items = run.store.items.slice(0, 2);
        const current = coordinatorInternals(newCoordinator(run.deps));
        await current.loadHistory();
        const outcome = await current.reconcileToolCalls().then(
            (statuses) => ({ statuses, error: null }),
            (error: unknown) => ({ statuses: [], error })
        );
        // reconciliation error = %v, want untranslated-call error
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error instanceof Error ? outcome.error.message : outcome.error).toBe(
            `reconcile untranslated tool call "call-0" in turn "turn-1"`
        );
        // reconciliation completed an untranslated call
        expect(outcome.statuses).toHaveLength(0);
        expect(run.store.appendedStatuses).toHaveLength(0);
        expect(current.toolCallStates()).toHaveLength(1);
        expect(current.pendingInputs()).toBe(0);
    });

    test("TestCoordinatorRunDefersCompletionsUntilModelFinishes", async () => {
        for (const startWithInput of [false, true]) {
            for (const steer of [false, true]) {
                const name = `input=${startWithInput}/steer=${steer}`;
                const run = newStopTestRun(3);
                const { store, operations, calls } = run;
                await run.start();

                const finishOperation = async (index: number) => {
                    operations.updateQueue.push({ ...store.resume.Operations[index], Status: "completed" });
                    await drainTasks();
                    await run.clock.advance(2 * SLURP_IDLE_MS);
                    // completed tool statuses = %d, want %d
                    expect(store.appendedStatuses, name).toHaveLength(index + 1);
                    // completed call = %q
                    expect(store.appendedStatuses[index].CallID, name).toBe(`call-${index}`);
                };

                let firstPending = 0;

                if (startWithInput) {
                    await run.inputs.submit(externalEvent("progress", "check progress"));
                    await drainTasks();
                    await run.clock.advance(2 * SLURP_IDLE_MS);
                } else {
                    await finishOperation(0);
                    firstPending = 1;
                }

                // model requests = %d, want 1
                expect(calls, name).toHaveLength(1);
                const first = calls[0];

                for (let index = firstPending; index < 3; index++) {
                    await finishOperation(index);
                    // operation %d canceled active model request: %v
                    expect(first.signal.aborted, name).toBe(false);
                    // model requests = %d, want 1
                    expect(calls, name).toHaveLength(1);
                }

                const response = {
                    ID: "progress-response",
                    Stop: "complete" as const,
                    Usage: usage(),
                    Output: [{ Type: "message" as const, Data: { Role: "assistant" as const, Text: "progress" } }],
                };

                if (steer) {
                    await run.inputs.submit(externalEvent("steering", "summarize results"));
                    await drainTasks();
                    await run.clock.advance(2 * SLURP_IDLE_MS);
                } else {
                    first.respond(response);
                    await drainTasks();
                    await run.clock.advance(2 * SLURP_IDLE_MS);
                }

                // model requests = %d, want 2
                expect(calls, name).toHaveLength(2);
                const next = calls[1];
                assertCompletedResults(next.request, 3);

                if (steer) {
                    // steering did not cancel active model request
                    expect(first.signal.aborted, name).toBe(true);
                    const last = next.request.Input[next.request.Input.length - 1];
                    // steering missing from request: %#v
                    expect(last.Type, name).toBe("message");
                    expect(last.Type === "message" ? last.Data.Text : null, name).toBe("summarize results");
                }

                next.respond({ ID: "final-response", Stop: "complete", Usage: usage() });
                await drainTasks();
                // model requests = %d, turns = %d, want 2 each
                expect(calls, name).toHaveLength(2);
                expect(store.appendedTurns, name).toHaveLength(2);

                if (!steer) {
                    // active model response was not preserved: %#v
                    expect(store.appendedResponses[0].Response, name).toEqual(response);
                }

                run.cancel(contextCanceled);
                await drainTasks();
                // Run error = %v, want context cancellation
                expect(errorIs(run.done.error, contextCanceled), name).toBe(true);
            }
        }
    });

    test("TestCoordinatorRunSlurpsIndependentOperationCompletions", async () => {
        const run = newStopTestRun(3);
        const { store, operations } = run;

        for (const value of store.resume.Operations) {
            operations.updateQueue.push({ ...value, Status: "completed" });
        }

        await run.start();
        await drainTasks();
        await run.clock.advance(2 * SLURP_IDLE_MS);
        const requests = run.adapter.requests;
        // model requests = %d, want 1
        expect(requests).toHaveLength(1);
        assertCompletedResults(requests[0], 3);
        // completion effects: operations=%d statuses=%d turns=%d
        expect(store.savedOperations).toHaveLength(3);
        expect(store.appendedStatuses).toHaveLength(3);
        expect(store.appendedTurns).toHaveLength(1);
        run.cancel(contextCanceled);
        await drainTasks();
        // Run error = %v, want context cancellation
        expect(errorIs(run.done.error, contextCanceled)).toBe(true);
    });

    test("TestCoordinatorRunPersistsCompletedUpdatesBeforeClosure", async () => {
        const run = newStopTestRun(3);
        const { store, operations, builder } = run;
        const completed: Operation[] = [];

        for (const value of store.resume.Operations) {
            const done: Operation = { ...value, Status: "completed" };
            completed.push(done);
            operations.updateQueue.push(done);
        }

        operations.updateQueue.close();
        await run.start();
        const error = await awaitDone(run);
        // Run error = %v, want closed operation updates error
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : error).toBe("operation updates closed");
        // completion effects: operations=%v statuses=%v
        expect(store.savedOperations).toEqual(completed);
        expect(store.appendedStatuses).toHaveLength(3);
        const built = builder.build();
        assertCompletedResults(built.Request, 3);
    });
});

// Twins of harness/coordinator/recovery_sequences_test.go.

import { describe, expect, test } from "bun:test";
import { AbortedError, drainTasks } from "./clock";
import { SLURP_IDLE_MS } from "./coordinator";
import type { Response } from "./llm";
import {
    assertCompletedResults,
    assertStopResult,
    externalEvent,
    FakeAdapter,
    newRegistry,
    newStopTestRun,
    newValueSpec,
    SubmittingTranslator,
    stopInput,
    type TestCall,
    textResponse,
    VIEW_IMAGE_NAME,
} from "./testing/driver";
import {
    errorIs,
    FailingBuilder,
    persistTestRun,
    prefixIDs,
    RecoveryFailureStore,
    restoreTestRun,
    statusAt,
} from "./testing/rest-helpers";

describe("recovery_sequences_test.go", () => {
    test("TestCoordinatorResumesMixedDeliveryAfterSteering", async () => {
        for (const stage of ["steered-request", "followup-request"]) {
            const run = newStopTestRun(2);
            const store = await persistTestRun(run);
            await restoreTestRun(run, store);
            const controller = new AbortController();
            // The first request ignores its own cancellation and only ends with the run context,
            // so its response arrives after steering replaced it.
            run.deps.llm = new FakeAdapter(
                (request, requestSignal) =>
                    new Promise<Response>((resolve, reject) => {
                        const call: TestCall = { signal: requestSignal, request, respond: resolve, fail: reject };
                        run.calls.push(call);
                        const signal = run.calls.length === 1 ? controller.signal : requestSignal;
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    })
            );
            await run.start(controller.signal);
            await run.input(externalEvent("first", "first input"));
            await run.update(0, "completed");
            await run.input(externalEvent("steer", "steering input"));
            await run.update(1, "completed");
            // steering did not replace the first request
            expect(run.calls).toHaveLength(2);
            expect(run.calls[0].signal.aborted).toBe(true);
            await run.respond(0, textResponse("Stale response."));
            // stale response consumed pending inputs
            expect(run.internals().deliveredInputs).toBe(0);
            let pending = 4;

            if (stage === "followup-request") {
                await run.respond(1, textResponse("Current response."));
                pending = 1;
                // completion during the steered request did not trigger delivery
                expect(run.calls).toHaveLength(3);
            }

            const canceled = new AbortedError("context canceled");
            controller.abort(canceled);
            await drainTasks();
            expect(run.done.settled).toBe(true);
            expect(errorIs(run.done.error, canceled)).toBe(true);

            const resumed = newStopTestRun(0);
            prefixIDs(resumed, "resumed");
            await restoreTestRun(resumed, store);
            await resumed.start();
            // replayed balance
            expect(resumed.internals().pendingInputs()).toBe(pending);
            // resumed requests
            expect(resumed.calls).toHaveLength(1);
            const request = resumed.calls[0].request;
            assertCompletedResults(request, 2);
            const messages = new Map<string, number>();

            for (const item of request.Input) {
                if (item.Type === "message") {
                    messages.set(item.Data.Text, (messages.get(item.Data.Text) ?? 0) + 1);
                }
            }

            // replayed messages
            expect(messages.get("first input") ?? 0).toBe(1);
            expect(messages.get("steering input") ?? 0).toBe(1);
            expect(messages.get("Stale response.") ?? 0).toBe(0);
            await resumed.input(stopInput("stop", "when_idle"));
            await resumed.respond(0, textResponse("Done."));
            resumed.assertStopped();
            // resumed delivery did not settle exactly once
            expect(resumed.internals().pendingInputs()).toBe(0);
            expect(resumed.calls).toHaveLength(1);
        }
    });

    test("TestCoordinatorResumesPartiallyCompletedToolCall", async () => {
        const run = newStopTestRun(1);
        const second = { ...run.store.resume.Operations[0], ID: "operation-1" };
        run.store.resume.Operations.push(second);
        const original = statusAt(run.store.items, 2);
        const status = {
            ...original,
            Status: { ...original.Status, WaitingFor: [...(original.Status.WaitingFor ?? []), second.ID] },
            Operations: [...(original.Operations ?? []), second],
        };
        run.store.items[2] = { ...run.store.items[2], Kind: "tool_call_status", Data: status };
        const store = await persistTestRun(run);
        const first = { ...status.Operations[0], Status: "completed" as const };
        await store.saveOperation("session-1", first);
        await restoreTestRun(run, store);
        await run.start();
        await run.input(stopInput("stop", "when_idle"));
        run.assertRunning();
        // partial completion produced a finished tool result
        expect(run.calls).toHaveLength(0);
        expect(run.internals().pendingInputs()).toBe(0);
        // unfinished operation was not dispatched
        expect(run.operations.adds.length).toBeGreaterThan(0);

        for (const dispatched of run.operations.adds) {
            // redispatched operation
            expect(dispatched).toEqual(second);
        }

        await run.update(1, "completed");
        // requests = N, want one completed tool result
        expect(run.calls).toHaveLength(1);
        assertStopResult(run.calls[0].request, "call-0", "completed,completed");
        let completedResults = 0;

        for (const item of run.calls[0].request.Input) {
            if (item.Type === "tool_result" && item.Data.Output[0]?.Value === "completed,completed") {
                completedResults++;
            }
        }

        // completed tool results
        expect(completedResults).toBe(1);
        await run.update(1, "completed");
        // duplicate terminal update changed the delivery balance
        expect(run.internals().pendingInputs()).toBe(1);
        await run.respond(0, textResponse("Done."));
        run.assertStopped();
        const resumed = newStopTestRun(0);
        prefixIDs(resumed, "resumed");
        await restoreTestRun(resumed, store);
        // settled operations were retained for recovery
        expect(resumed.deps.restored.Operations).toHaveLength(0);
        await resumed.start();
        await resumed.input(stopInput("stop-again", "when_idle"));
        resumed.assertStopped();
        // settled tool call ran again on resume
        expect(resumed.calls).toHaveLength(0);
        expect(resumed.operations.adds).toHaveLength(0);
    });

    test("TestCoordinatorRetriesRecoveryPersistenceFailures", async () => {
        for (const failure of ["reconciliation", "initial-build", "initial-turn"]) {
            const run = newStopTestRun(1);
            const store = await persistTestRun(run);
            const want = new Error("injected failure");
            const faults = new RecoveryFailureStore(store);
            const terminal = "completed" as const;
            const value = { ...run.store.resume.Operations[0], Status: terminal };
            await store.saveOperation("session-1", value);

            switch (failure) {
                case "reconciliation":
                    faults.statusErr = want;
                    break;
                case "initial-build":
                    run.deps.contextBuilder = new FailingBuilder(run.deps.contextBuilder, want);
                    break;
                case "initial-turn":
                    faults.turnErr = want;
                    break;
            }

            await restoreTestRun(run, faults);
            await run.start();
            // Run did not return the persistence failure
            expect({ failure, settled: run.done.settled }).toEqual({ failure, settled: true });
            expect({ failure, is: errorIs(run.done.error, want) }).toEqual({ failure, is: true });
            // model request started before its prerequisites were committed
            expect(run.calls).toHaveLength(0);
            const page = await store.items("session-1", 0, 100);
            const turns = page.Items.filter((item) => item.Kind === "turn").length;
            // failed recovery persisted an extra turn
            expect(turns).toBe(1);

            const resumed = newStopTestRun(0);
            prefixIDs(resumed, "resumed");
            await restoreTestRun(resumed, store);
            await resumed.start();
            await resumed.input(stopInput("stop", "when_idle"));
            // retry did not deliver the saved result without redispatch
            expect(resumed.calls).toHaveLength(1);
            expect(resumed.operations.adds).toHaveLength(0);
            assertStopResult(resumed.calls[0].request, "call-0", terminal);
            await resumed.respond(0, textResponse("Done."));
            resumed.assertStopped();
            // retry did not settle delivery exactly once
            expect(resumed.internals().pendingInputs()).toBe(0);
            expect(resumed.calls).toHaveLength(1);
        }
    });

    test("TestCoordinatorRetriesInitialToolStatusPersistenceFailure", async () => {
        const run = newStopTestRun(1);
        run.store.items = run.store.items.slice(0, 2);
        const store = await persistTestRun(run);
        const spec = newValueSpec("1");
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        const registry = newRegistry({ ViewImage: translator }, VIEW_IMAGE_NAME);
        run.deps.tools = registry;
        const want = new Error("cannot persist initial tool status");
        const faults = new RecoveryFailureStore(store);
        faults.statusErr = want;
        await restoreTestRun(run, faults);
        await run.start();
        // Run did not return the persistence failure
        expect(run.done.settled).toBe(true);
        expect(errorIs(run.done.error, want)).toBe(true);
        // failed status commit did not prevent dispatch and model requests
        expect(translator.calls).toHaveLength(1);
        expect(run.operations.adds).toHaveLength(0);
        expect(run.calls).toHaveLength(0);
        const page = await store.items("session-1", 0, 100);
        // history after failed commit
        expect(page.Items).toHaveLength(2);
        expect(page.Items[1].Kind).toBe("model_response");

        const resumed = newStopTestRun(0);
        prefixIDs(resumed, "resumed");
        resumed.deps.tools = registry;
        await restoreTestRun(resumed, store);
        // failed status commit persisted operations
        expect(resumed.deps.restored.Operations).toHaveLength(0);
        await resumed.start();
        // retry did not translate and dispatch the unfinished call
        expect(translator.calls).toHaveLength(2);
        expect(resumed.operations.adds).toHaveLength(1);
        const restored = await store.resume("session-1");
        // dispatched operation differs from committed operation
        expect(restored.Operations).toEqual(resumed.operations.adds);
        const completed = { ...resumed.operations.adds[0], Status: "completed" as const };
        resumed.operations.updateQueue.push(completed);
        await resumed.sleep(2 * SLURP_IDLE_MS);
        await resumed.input(stopInput("stop", "when_idle"));
        // requests = N, want completed result delivery
        expect(resumed.calls).toHaveLength(1);
        assertStopResult(resumed.calls[0].request, "call-0", "");
        await resumed.respond(0, textResponse("Done."));
        resumed.assertStopped();
    });
});

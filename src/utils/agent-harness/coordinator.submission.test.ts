// Twins of harness/coordinator/submission_test.go.
//
// Mapping: `persistTestRun` / `restoreTestRun` (recovery_sequences_test.go) are the hss-helpers
// versions over `MemoryStore` (the Go `localfile.Store` is not ported). A restored run starts with
// `run.start(signal)`, which keeps the `deps.restored` that `restoreTestRun` set.
// `run.current.state.availableInputs` is `pendingInputs() + deliveredInputs` (pendingInputs is
// `availableInputs - deliveredInputs` in both ports; internals do not expose availableInputs).
// `context.Canceled` is `contextCanceled`; a blocking `<-run.done` is `awaitDone(run)`.

import { describe, expect, test } from "bun:test";
import { drainTasks } from "./clock";
import { TOOL_CALL_RUNNING_PAYLOAD } from "./contextbuilder";
import { SLURP_IDLE_MS } from "./coordinator";
import type { Input } from "./inbox";
import type { Item, Request, Response } from "./llm";
import type { Status } from "./operation";
import {
    assertCompletedResults,
    assertStopResult,
    BASH_NAME,
    externalEvent,
    newRegistry,
    newStopTestRun,
    newValueSpec,
    OperationStatusTranslator,
    type StopTestRun,
    SubmissionTranslator,
    stopInput,
    textResponse,
    usage,
    VIEW_IMAGE_NAME,
} from "./testing/driver";
import {
    awaitDone,
    contextCanceled,
    errorIs,
    persistTestRun,
    restoreTestRun,
    SubmissionFailureStore,
} from "./testing/hss-helpers";

const NS = 1e-6;
const SECOND = 1000;

function toolResult(callID: string, value: string): Item {
    return { Type: "tool_result", Data: { CallID: callID, Output: [{ Kind: "text", Value: value }] } };
}

function userMessage(text: string): Item {
    return { Type: "message", Data: { Role: "user", Text: text } };
}

function completedResult(callID: string): Item {
    const completed: Status = "completed";
    return toolResult(callID, completed);
}

function availableInputs(run: StopTestRun): number {
    const current = run.internals();
    return current.pendingInputs() + current.deliveredInputs;
}

describe("submission_test.go", () => {
    test("TestCoordinatorSubmissionBoundarySurvivesRecovery", async () => {
        for (const stage of ["in flight", "response committed", "turn write failed", "response write failed"]) {
            const run = newStopTestRun(2);
            const store = await persistTestRun(run);
            const faults = new SubmissionFailureStore(store);
            await restoreTestRun(run, faults);
            const controller = new AbortController();
            await run.start(controller.signal);
            await run.update(1, "completed");
            // completion before submission was not included immediately
            expect(run.calls, stage).toHaveLength(1);
            expect(run.internals().currentTurnInputs, stage).toBe(1);
            const sent = run.calls[0].request;
            const original = [...sent.Input];
            assertStopResult(sent, "call-1", "completed");
            assertStopResult(sent, "call-0", TOOL_CALL_RUNNING_PAYLOAD);

            for (const item of sent.Input) {
                if (item.Type !== "tool_result") {
                    continue;
                }

                // completion before submission retained its running placeholder
                expect(
                    item.Data.CallID === "call-1" && item.Data.Output[0]?.Value === TOOL_CALL_RUNNING_PAYLOAD,
                    stage
                ).toBe(false);
            }

            await run.update(0, "completed");
            await run.input(stopInput("heartbeat", "heartbeat"));
            // late inputs interrupted or replaced the request
            expect(run.calls, stage).toHaveLength(1);
            expect(run.calls[0].signal.aborted, stage).toBe(false);
            const suffix: Item[] = [completedResult("call-0"), userMessage("user requested stop")];
            const want: Request = { ...sent, Input: [...original, ...suffix] };
            const response = textResponse("Waiting for A.");
            const failure = new Error("injected write failure");

            switch (stage) {
                case "turn write failed":
                    faults.turnErr = failure;
                    break;
                case "response write failed":
                    faults.responseErr = failure;
                    break;
            }

            if (stage !== "in flight") {
                await run.respond(0, response);

                if (stage !== "response write failed") {
                    want.Input = [...original, ...(response.Output ?? []), ...suffix];
                }
            }

            if (stage === "response committed") {
                // next request did not place the response before late inputs
                expect(run.calls, stage).toHaveLength(2);
                expect(run.calls[1].request, stage).toEqual(want);
                // late inputs were counted as delivered by the earlier response
                expect(run.internals().deliveredInputs, stage).toBe(1);
                expect(run.internals().currentTurnInputs, stage).toBe(3);
            }

            // in-flight request was mutated
            expect(sent.Input, stage).toEqual(original);

            if (stage === "turn write failed" || stage === "response write failed") {
                // Run error = %v, want %v
                expect(errorIs(await awaitDone(run), failure), stage).toBe(true);
                // failed persistence started another model request
                expect(run.calls, stage).toHaveLength(1);
            } else {
                controller.abort(contextCanceled);
                await drainTasks();
                expect(errorIs(await awaitDone(run), contextCanceled), stage).toBe(true);
            }

            const resumed = newStopTestRun(0);
            await restoreTestRun(resumed, store);
            await resumed.start();
            // resume did not reconstruct submitted history and include pending inputs
            expect(resumed.calls, stage).toHaveLength(1);
            expect(resumed.calls[0].request, stage).toEqual(want);
            assertCompletedResults(resumed.calls[0].request, 2);
            // resume redispatched completed operations
            expect(resumed.operations.adds, stage).toHaveLength(0);
            await resumed.input(stopInput("stop", "when_idle"));
            await resumed.respond(0, textResponse("Done."));
            resumed.assertStopped();
            // completion delivery did not settle in one response
            expect(resumed.internals().pendingInputs(), stage).toBe(0);
            expect(resumed.calls, stage).toHaveLength(1);
        }
    });

    test("TestCoordinatorSteeringCommitsPendingSuffixBeforeNewResponse", async () => {
        const run = newStopTestRun(2);
        const store = await persistTestRun(run);
        await restoreTestRun(run, store);
        await run.start();
        await run.input(externalEvent("first", "first input"));
        const initial = run.calls[0].request;
        await run.update(0, "completed");
        await run.input(externalEvent("steer", "steering input"));
        // steering did not replace the request
        expect(run.calls).toHaveLength(2);
        expect(run.calls[0].signal.aborted).toBe(true);
        const want: Request = {
            ...initial,
            Input: [...initial.Input, completedResult("call-0"), userMessage("steering input")],
        };
        // replacement request omitted or reordered pending inputs
        expect(run.calls[1].request).toEqual(want);
        await run.update(1, "completed");
        const response = textResponse("Current response.");
        await run.respond(1, response);
        want.Input = [...want.Input, ...(response.Output ?? []), completedResult("call-1")];
        // new response did not land at the replacement request boundary
        expect(run.calls).toHaveLength(3);
        expect(run.calls[2].request).toEqual(want);
        await run.input(stopInput("stop", "when_idle"));
        await run.respond(2, textResponse("Done."));
        run.assertStopped();
    });

    test("TestCoordinatorRecoversPendingResultsAfterInputWriteFailure", async () => {
        for (const kind of ["external", "heartbeat", "hard stop"]) {
            const run = newStopTestRun(2);
            const store = await persistTestRun(run);
            const faults = new SubmissionFailureStore(store);
            await restoreTestRun(run, faults);
            await run.start();
            await run.update(1, "completed");
            const want: Request = { ...run.calls[0].request };
            await run.update(0, "completed");
            want.Input = [...want.Input, completedResult("call-0")];
            let input: Input = externalEvent("unpersisted", "unpersisted input");

            switch (kind) {
                case "heartbeat":
                    input = stopInput("unpersisted", "heartbeat");
                    break;
                case "hard stop":
                    input = stopInput("unpersisted", "hard");
                    break;
            }

            const failure = new Error("input write failed");
            faults.inputErr = failure;
            await run.input(input);
            // Run error = %v, want %v
            expect(errorIs(await awaitDone(run), failure), kind).toBe(true);
            // unpersisted input triggered a request or cancellation
            expect(run.calls, kind).toHaveLength(1);
            expect(run.operations.cancels, kind).toHaveLength(0);
            const resumed = newStopTestRun(0);
            await restoreTestRun(resumed, store);
            await resumed.start();
            // resume lost persisted results or retained the failed input
            expect(resumed.calls, kind).toHaveLength(1);
            expect(resumed.calls[0].request, kind).toEqual(want);
            // resume miscounted results or redispatched completed operations
            expect(availableInputs(resumed), kind).toBe(2);
            expect(resumed.operations.adds, kind).toHaveLength(0);
            await resumed.input(stopInput("stop", "when_idle"));
            await resumed.respond(0, textResponse("Done."));
            resumed.assertStopped();
            // restored results were not delivered exactly once
            expect(resumed.internals().pendingInputs(), kind).toBe(0);
            expect(resumed.calls, kind).toHaveLength(1);
        }
    });

    test("TestCoordinatorStartsNewToolWhileDeliveringPreviousCompletion", async () => {
        const run = newStopTestRun(2);
        const store = await persistTestRun(run);
        const spec = newValueSpec("1");
        const translator = new SubmissionTranslator();
        translator.specs = [spec];
        run.deps.tools = newRegistry(
            { Bash: translator, ViewImage: new OperationStatusTranslator() },
            BASH_NAME,
            VIEW_IMAGE_NAME
        );
        await restoreTestRun(run, store);
        const controller = new AbortController();
        await run.start(controller.signal);
        await run.update(1, "completed");
        const first = run.calls[0].request;
        await run.update(0, "completed");
        const dispatches = run.operations.adds.length;
        const response: Response = {
            ID: "",
            Stop: "complete",
            Usage: usage(),
            Output: [
                {
                    ProviderID: "reasoning",
                    Type: "reasoning",
                    Data: {
                        Raw: `{"id":"reasoning","type":"reasoning","summary":[],"encrypted_content":"opaque"}`,
                    },
                },
                { ProviderID: "item-C", Type: "tool_call", Data: { CallID: "C", Name: BASH_NAME, Arguments: "{}" } },
            ],
        };
        await run.respond(0, response);
        // previous completion started a turn instead of waiting for the new tool
        expect(run.requestCount()).toBe(1);
        await run.clock.advance(SECOND - NS);
        // previous completion started a turn before the tool grace period elapsed
        expect(run.requestCount()).toBe(1);
        await run.clock.advance(NS);
        const want: Request = {
            ...first,
            Input: [
                ...first.Input,
                ...(response.Output ?? []),
                completedResult("call-0"),
                toolResult("C", TOOL_CALL_RUNNING_PAYLOAD),
            ],
        };
        // new tool response, old completion, and new running result were reordered
        expect(run.calls).toHaveLength(2);
        expect(run.calls[1].request).toEqual(want);
        // new work: translations=%d, dispatches=%d, delivered=%d, submitted=%d
        expect(translator.calls).toHaveLength(1);
        expect(run.operations.adds.length).toBeGreaterThan(dispatches);
        expect(run.internals().deliveredInputs).toBe(1);
        expect(run.internals().currentTurnInputs).toBe(2);
        run.operations.updateQueue.push({ ...run.operations.adds[dispatches], Status: "completed" });
        await drainTasks();
        await run.clock.advance(2 * SLURP_IDLE_MS);
        await drainTasks();
        const secondResponse = textResponse("Waiting for C.");
        await run.respond(1, secondResponse);
        want.Input = [...want.Input, ...(secondResponse.Output ?? []), completedResult("C")];
        // new completion was not delivered after its in-flight response
        expect(run.calls).toHaveLength(3);
        expect(run.calls[2].request).toEqual(want);
        expect(run.internals().deliveredInputs).toBe(2);
        controller.abort(contextCanceled);
        await drainTasks();
        expect(errorIs(await awaitDone(run), contextCanceled)).toBe(true);
        const resumed = newStopTestRun(0);
        resumed.deps.tools = newRegistry(
            { Bash: translator, ViewImage: new OperationStatusTranslator() },
            BASH_NAME,
            VIEW_IMAGE_NAME
        );
        await restoreTestRun(resumed, store);
        await resumed.start();
        // replay changed the request or repeated completed work
        expect(resumed.calls).toHaveLength(1);
        expect(resumed.calls[0].request).toEqual(want);
        expect(resumed.operations.adds).toHaveLength(0);
        expect(translator.calls).toHaveLength(1);
        await resumed.input(stopInput("stop", "when_idle"));
        await resumed.respond(0, textResponse("Done."));
        resumed.assertStopped();
        // completed calls were not delivered exactly once
        expect(resumed.internals().pendingInputs()).toBe(0);
        expect(availableInputs(resumed)).toBe(3);
        expect(resumed.calls).toHaveLength(1);
    });

    test("TestCoordinatorHardStopPreservesPendingInputsOnReplay", async () => {
        const run = newStopTestRun(2);
        const store = await persistTestRun(run);
        await restoreTestRun(run, store);
        await run.start();
        await run.input(externalEvent("first", "check progress"));
        const want: Request = { ...run.calls[0].request };
        await run.update(0, "completed");
        await run.input(stopInput("hard", "hard"));
        // hard stop failed to interrupt and cancel only pending work
        expect(run.calls).toHaveLength(1);
        expect(run.calls[0].signal.aborted).toBe(true);
        expect(run.operations.cancels).toHaveLength(1);
        await run.input(externalEvent("late", "follow up after stop"));
        await run.update(1, "canceled");
        run.assertStopped();
        // hard stop started another model request
        expect(run.calls).toHaveLength(1);
        want.Input = [
            ...want.Input,
            completedResult("call-0"),
            userMessage("follow up after stop"),
            toolResult("call-1", "canceled"),
        ];
        const resumed = newStopTestRun(0);
        await restoreTestRun(resumed, store);
        await resumed.start();
        // resume changed stop history, lost late input, or repeated operations
        expect(resumed.calls).toHaveLength(1);
        expect(resumed.calls[0].request).toEqual(want);
        expect(resumed.operations.adds).toHaveLength(0);
        expect(resumed.operations.cancels).toHaveLength(0);
        await resumed.input(stopInput("idle", "when_idle"));
        await resumed.respond(0, textResponse("Follow-up received."));
        resumed.assertStopped();
        // resumed stop history did not settle in one response
        expect(resumed.internals().pendingInputs()).toBe(0);
        expect(resumed.calls).toHaveLength(1);
    });
});

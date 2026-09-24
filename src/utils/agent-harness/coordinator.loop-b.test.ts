// Twins of harness/coordinator/loop_test.go, second half: from
// TestCoordinatorRunDropsSuccessfulResponseFromSupersededTurn to
// TestClosedInputErrorPrefersContextCancellation.

import { describe, expect, test } from "bun:test";
import { AbortedError, drainTasks } from "./clock";
import { newBuilder } from "./contextbuilder";
import type { Coordinator } from "./coordinator";
import type { Request, Response, ToolCall } from "./llm";
import { type Operation, type Spec, type Status, UnsupportedOperationError } from "./operation";
import type { Item, ModelResponse, ToolCallStatus, Turn } from "./sessionstore";
import {
    assertStopResult,
    BASH_NAME,
    emptyFakeStore,
    externalEvent,
    FakeAdapter,
    FakeOperationManager,
    FakeStore,
    newRegistry,
    newTestCoordinator,
    newTestCoordinatorWithAdapter,
    newValueSpec,
    oracle,
    SubmittingTranslator,
    storedItem,
    TerminalResultTranslator,
    TestTranslator,
    TYPE_SHELL,
    usage,
    VIEW_IMAGE_NAME,
    withPreamble,
} from "./testing/driver";
import {
    addOperationToLocalState,
    addToolCallsToLocalState,
    closedInputError,
    DirectRun,
    errorChainHas,
    errorChainIncludes,
    errorMessage,
    MutatingOperationManager,
    runToEnd,
    storeItemInSessionStore,
} from "./testing/loop-b-helpers";

function waitForAbort(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function hasToolCall(states: Array<{ turnID: string; callID: string }>, turnID: string, callID: string): boolean {
    return states.some((state) => state.turnID === turnID && state.callID === callID);
}

// White-box twins (see loop-a): port-only.
describe.skipIf(oracle)("loop_test.go (2/2)", () => {
    test("TestCoordinatorRunDropsSuccessfulResponseFromSupersededTurn", async () => {
        const spec = newValueSpec('{"value":1}');
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        const firstResponse: Response = {
            ID: "response-1",
            Stop: "complete",
            Usage: usage(),
            Output: [{ Type: "tool_call", Data: { CallID: "stale-call", Name: BASH_NAME, Arguments: "{}" } }],
        };
        const secondResponse: Response = {
            ID: "response-2",
            Stop: "complete",
            Usage: usage(),
            Output: [{ Type: "message", Data: { Role: "assistant", Text: "current answer" } }],
        };
        const started: Request[] = [];
        let firstReturned = false;
        let releaseSecond: () => void = () => {};
        const secondReleased = new Promise<void>((resolve) => {
            releaseSecond = resolve;
        });
        const responseStored: ModelResponse[] = [];
        const store = emptyFakeStore();
        store.onAppendModelResponse = (response) => {
            responseStored.push(response);
        };
        const adapter = new FakeAdapter(async (request, signal) => {
            started.push(request);

            if (request.Input.length === 2) {
                await waitForAbort(signal);
                firstReturned = true;
                return firstResponse;
            }

            await secondReleased;
            return secondResponse;
        });
        const direct = newTestCoordinatorWithAdapter(store, newRegistry({ Bash: translator }, BASH_NAME), adapter, {
            builder: newBuilder(),
            operations: new FakeOperationManager(),
        });
        const run = new DirectRun(direct);
        await run.start();

        await direct.inputs.submit(externalEvent("input-1", "first"));
        await run.settle();
        expect(started).toHaveLength(1);
        await direct.inputs.submit(externalEvent("input-2", "second"));
        await run.settle();
        expect(started).toHaveLength(2);
        expect(firstReturned).toBe(true);
        await run.sleep(20);
        releaseSecond();
        await run.settle();
        expect(responseStored.length).toBeGreaterThanOrEqual(1);
        const stored = responseStored[0];
        expect(store.appendedTurns).toHaveLength(2);
        expect(stored.TurnID).toBe(store.appendedTurns[1].ID);
        expect(stored.Response).toEqual(secondResponse);
        await run.sleep(20);
        expect(responseStored).toHaveLength(1);

        const canceled = new AbortedError("canceled");
        run.cancel(canceled);
        expect(errorChainIncludes(await run.result(), canceled)).toBe(true);
        expect(store.appendedResponses).toEqual([stored]);
        expect(translator.calls).toHaveLength(0);
        expect(store.appendedStatuses).toHaveLength(0);
    });

    test("TestCoordinatorRunReturnsCurrentModelError", async () => {
        const providerErr = new Error("provider unavailable");
        const adapter = new FakeAdapter(async () => {
            throw providerErr;
        });
        const store = emptyFakeStore();
        const direct = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter);
        const run = new DirectRun(direct);
        await run.start();

        await direct.inputs.submit(externalEvent("input-1", "hello"));
        const error = await run.result();
        expect(errorChainIncludes(error, providerErr)).toBe(true);
        expect(errorMessage(error)).toContain("call model for turn");
        expect(store.appendedTurns).toHaveLength(1);
        expect(store.appendedResponses).toHaveLength(0);
    });

    test("TestCoordinatorHandlesModelResponseBeforeSchedulingToolCalls", async () => {
        const spec = newValueSpec('{"value":1}');
        const response: ModelResponse = {
            TurnID: "turn-1",
            Response: {
                ID: "response-1",
                Stop: "complete",
                Usage: usage(),
                Output: [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
            },
        };
        const store = emptyFakeStore();
        let storedBeforeTranslation = false;
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        translator.onTranslate = () => {
            storedBeforeTranslation = Bun.deepEquals(store.appendedResponses, [response]);
        };
        const operations = new FakeOperationManager();
        const { internals } = newTestCoordinator(store, newRegistry({ Bash: translator }, BASH_NAME), {
            operations,
            builder: newBuilder(),
        });

        await internals.handleModelResponse(response);
        // The tool call must not be translated before its model response is stored.
        expect(storedBeforeTranslation).toBe(true);
        expect(store.appendedStatuses).toHaveLength(1);
        expect(store.appendedStatuses[0].Operations ?? []).toHaveLength(1);
        // The handler must not dispatch operations itself.
        expect(operations.adds).toHaveLength(0);
    });

    test("TestCoordinatorDoesNotScheduleToolCallsWhenModelResponseStoreFails", async () => {
        const store = emptyFakeStore();
        store.appendModelResponseErr = new Error("disk unavailable");
        const translator = new SubmittingTranslator();
        const { internals } = newTestCoordinator(store, newRegistry({ Bash: translator }, BASH_NAME));
        const response: ModelResponse = {
            TurnID: "turn-1",
            Response: {
                ID: "",
                Stop: "complete",
                Usage: usage(),
                Output: [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
            },
        };

        let error: unknown;

        try {
            await internals.handleModelResponse(response);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('store turn "turn-1" response: disk unavailable');
        expect(store.appendedResponses).toEqual([response]);
        // Nothing may be scheduled after the response store failed.
        expect(translator.calls).toHaveLength(0);
        expect(store.appendedStatuses).toHaveLength(0);
        expect(internals.operationStates().size).toBe(0);
    });

    test("TestCoordinatorHandlesModelResponseWithoutToolCalls", async () => {
        const store = emptyFakeStore();
        const { internals } = newTestCoordinator(store, newRegistry({}));
        const response: ModelResponse = {
            TurnID: "turn-1",
            Response: {
                ID: "",
                Stop: "complete",
                Usage: usage(),
                Output: [{ Type: "message", Data: { Role: "assistant", Text: "done" } }],
            },
        };

        await internals.handleModelResponse(response);
        expect(store.appendedResponses).toEqual([response]);
        expect(store.appendedStatuses).toHaveLength(0);
        expect(internals.operationStates().size).toBe(0);
    });

    test("TestCoordinatorRunSchedulesToolCallsWithoutStatusBeforeDispatch", async () => {
        const firstSpec: Spec = newValueSpec('{"value":1}');
        const secondSpec: Spec = newValueSpec('{"value":2}');
        firstSpec.MaxOutputLength = 3;
        secondSpec.MaxOutputLength = 7;
        const translator = new SubmittingTranslator();
        translator.specs = [firstSpec, secondSpec];
        const registry = newRegistry({ Bash: translator }, BASH_NAME);
        const handled: ToolCall = { CallID: "call-handled", Name: BASH_NAME, Arguments: "{}" };
        const missing: ToolCall = { CallID: "call-missing", Name: BASH_NAME, Arguments: "{}" };
        const store = new FakeStore("session-1");
        store.items = [
            storedItem(1, { Kind: "turn", Data: { ID: "turn-1", PreviousTurnID: "", Type: "regular" } }),
            storedItem(2, {
                Kind: "model_response",
                Data: {
                    TurnID: "turn-1",
                    Response: {
                        ID: "",
                        Stop: "complete",
                        Usage: usage(),
                        Output: [
                            { Type: "tool_call", Data: handled },
                            { Type: "tool_call", Data: missing },
                        ],
                    },
                },
            }),
            storedItem(3, {
                Kind: "tool_call_status",
                Data: { TurnID: "turn-1", CallID: handled.CallID, Status: { Error: "already handled" } },
            }),
        ];
        const operations = new FakeOperationManager();
        operations.addError = () => {
            if (store.appendedStatuses.length !== 1 || store.appendedStatuses[0].CallID !== missing.CallID) {
                return new Error("operation dispatched before tool-call status was stored");
            }

            return null;
        };
        const requests: Request[] = [];
        const adapter = new FakeAdapter(async (request, signal) => {
            requests.push(request);
            await waitForAbort(signal);
            throw signal.reason;
        });
        const direct = newTestCoordinatorWithAdapter(store, registry, adapter, {
            operations,
            builder: newBuilder(),
        });
        // The Go test hands the coordinator an inbox whose context is already canceled.
        direct.inboxController.abort();

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe("inbox output closed");
        expect(translator.calls).toEqual([missing]);
        expect(store.appendedStatuses).toHaveLength(1);
        const status = store.appendedStatuses[0];
        expect(status.TurnID).toBe("turn-1");
        expect(status.CallID).toBe(missing.CallID);
        expect(status.Status.WaitingFor ?? []).toHaveLength(2);
        expect(status.Operations ?? []).toHaveLength(2);
        const wantOperations = new Map<string, Operation>();

        for (const [index, value] of (status.Operations ?? []).entries()) {
            expect(value.ID).not.toBe("");
            expect(value.ID).toBe((status.Status.WaitingFor ?? [])[index]);
            expect(value.Status).toBe("ready");
            expect(value.MaxOutputLength).toBe(translator.specs[index].MaxOutputLength);
            wantOperations.set(value.ID, value);
            expect(direct.internals.operationStates().get(value.ID)).toEqual(value);
        }

        const gotOperations = new Map<string, Operation>();

        for (const value of operations.adds) {
            gotOperations.set(value.ID, value);
        }

        expect(gotOperations).toEqual(wantOperations);
        await direct.internals.scheduleToolCalls();
        // A call that already has a status must not be scheduled again.
        expect(translator.calls).toHaveLength(1);
        expect(store.appendedStatuses).toHaveLength(1);
        expect(requests.length).toBeGreaterThanOrEqual(1);
        assertStopResult(requests[0], handled.CallID, "already handled");
    });

    test("TestCoordinatorRunStartsCorrectiveTurnForRecoveredValidationError", async () => {
        const call: ToolCall = { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" };
        const store = emptyFakeStore();
        store.items = [
            storedItem(1, { Kind: "turn", Data: { ID: "turn-1", PreviousTurnID: "", Type: "regular" } }),
            storedItem(2, {
                Kind: "model_response",
                Data: {
                    TurnID: "turn-1",
                    Response: { ID: "", Stop: "complete", Usage: usage(), Output: [{ Type: "tool_call", Data: call }] },
                },
            }),
        ];
        const started: Request[] = [];
        const adapter = new FakeAdapter(async (request, signal) => {
            started.push(request);
            await waitForAbort(signal);
            throw signal.reason;
        });
        const direct = newTestCoordinatorWithAdapter(store, newRegistry({}, BASH_NAME), adapter);
        const run = new DirectRun(direct);
        await run.start();

        await run.settle();
        expect(started).toHaveLength(1);
        const request = started[0];
        const canceled = new AbortedError("canceled");
        run.cancel(canceled);
        expect(errorChainIncludes(await run.result(), canceled)).toBe(true);
        expect(store.appendedStatuses).toHaveLength(1);
        expect(store.appendedStatuses[0].Status.Error).not.toBe("");
        expect(store.appendedTurns).toHaveLength(1);
        expect(store.appendedTurns[0].PreviousTurnID).toBe("turn-1");
        expect(request.Input).toHaveLength(3);
        expect(request.Input[2].Type).toBe("tool_result");
    });

    test("TestCoordinatorRunRejectsExternalInputWithoutTextPayload", async () => {
        const store = emptyFakeStore();
        const direct = newTestCoordinator(store, newRegistry({}));
        await direct.inputs.submit({ ID: "input-1", Kind: "external", Payload: "{}" });

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toContain('add input "input-1" to context');
        expect(store.appendedInputs).toHaveLength(0);
    });

    test("TestCoordinatorRunStoresOperationUpdatesWithoutRedispatch", async () => {
        const store = emptyFakeStore();
        const initial: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        store.resume.Operations = [initial];
        const operations = new FakeOperationManager();
        const updated: Operation = { ...initial, Status: "awaiting" };
        operations.updateQueue.push(updated);
        operations.updateQueue.close();
        const adapter = new FakeAdapter();
        const direct = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter, {
            operations,
            builder: newBuilder(),
        });

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe("operation updates closed");
        expect(direct.internals.operationStates().get(initial.ID)).toEqual(updated);
        expect(store.savedOperations).toEqual([updated]);
        // Only the initial operation is dispatched; the update is not re-dispatched.
        expect(operations.adds).toEqual([initial]);
        expect(operations.cancels).toHaveLength(0);
        expect(adapter.requests).toHaveLength(0);
    });

    test("TestCoordinatorReconcilesToolCallsFromPersistedOperationUpdates", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const store = emptyFakeStore();
        const builder = newBuilder();
        const { current, internals } = newTestCoordinator(store, registry, {
            operations: new FakeOperationManager(),
            builder,
        });
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        internals.addItemToLocalState({
            Kind: "model_response",
            Data: {
                TurnID: "turn-1",
                Response: { ID: "", Stop: "complete", Usage: usage(), Output: [{ Type: "tool_call", Data: call }] },
            },
        });
        const operations: Operation[] = [
            { ID: "operation-1", Type: "", Version: 0, Status: "ready" },
            { ID: "operation-2", Type: "", Version: 0, Status: "awaiting" },
        ];

        for (const value of operations) {
            addOperationToLocalState(current, value);
        }

        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: [operations[0].ID, operations[1].ID] },
        };
        internals.addItemToLocalState({ Kind: "tool_call_status", Data: status });

        const first: Operation = { ...operations[0], Status: "completed" };
        await internals.handleOperationUpdate(first);
        await internals.reconcileToolCalls();
        // The tool call must stay until every operation is terminal.
        expect(hasToolCall(internals.toolCallStates(), status.TurnID, status.CallID)).toBe(true);

        const second: Operation = { ...operations[1], Status: "failed" };
        await internals.handleOperationUpdate(second);
        await internals.reconcileToolCalls();
        expect(hasToolCall(internals.toolCallStates(), status.TurnID, status.CallID)).toBe(false);
        expect(store.savedOperations).toEqual([first, second]);
        expect(store.appendedStatuses).toEqual([
            {
                TurnID: status.TurnID,
                CallID: status.CallID,
                Status: status.Status,
                Operations: [first, second],
            },
        ]);
        const built = builder.build();
        const want = withPreamble(
            { Type: "tool_call", Data: call },
            { Type: "tool_result", Data: { CallID: call.CallID, Output: [{ Kind: "text", Value: "error:" }] } }
        );
        expect(built.Request.Input).toEqual(want);
    });

    test("TestCoordinatorRunReturnsReconciliationError", async () => {
        const registry = newRegistry({ ViewImage: new TerminalResultTranslator() }, VIEW_IMAGE_NAME);
        const value: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: [value.ID] },
        };
        const store = emptyFakeStore();
        store.resume.Operations = [value];
        store.items = [
            storedItem(1, {
                Kind: "model_response",
                Data: {
                    TurnID: "turn-1",
                    Response: { ID: "", Stop: "complete", Usage: usage(), Output: [{ Type: "tool_call", Data: call }] },
                },
            }),
            storedItem(2, { Kind: "tool_call_status", Data: status }),
            storedItem(3, {
                Kind: "tool_call_status",
                Data: { TurnID: "another-turn", CallID: "another-call", Status: { Error: "" } },
            }),
            storedItem(4, { Kind: "turn", Data: { ID: "turn-2", PreviousTurnID: "", Type: "regular" } }),
        ];
        const completed: Operation = { ...value, Status: "completed" };
        const operations = new FakeOperationManager();
        operations.updateQueue.push(completed);
        const direct = newTestCoordinator(store, registry, { operations, builder: newBuilder() });

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('add tool call "call-1" result to context: terminal result failed');
        expect(store.savedOperations).toEqual([completed]);
    });

    test("TestCoordinatorDoesNotCompleteToolCallBeforeOperationIsStored", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const store = emptyFakeStore();
        store.saveOperationErr = new Error("disk unavailable");
        const builder = newBuilder();
        const { current, internals } = newTestCoordinator(store, registry, {
            operations: new FakeOperationManager(),
            builder,
        });
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        addToolCallsToLocalState(current, {
            TurnID: "turn-1",
            Response: { ID: "", Stop: "complete", Usage: usage(), Output: [{ Type: "tool_call", Data: call }] },
        });
        const value: Operation = { ID: "operation-1", Type: "", Version: 0, Status: "ready" };
        addOperationToLocalState(current, value);
        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: [value.ID] },
        };
        internals.addItemToLocalState({ Kind: "tool_call_status", Data: status });

        const completed: Operation = { ...value, Status: "completed" };
        let error: unknown;

        try {
            await internals.handleOperationUpdate(completed);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('store operation "operation-1": disk unavailable');
        // The tool call must not be removed before its operation was stored.
        expect(hasToolCall(internals.toolCallStates(), status.TurnID, status.CallID)).toBe(true);
        const built = builder.build();
        // Only the initial result.
        expect(built.Request.Input).toHaveLength(2);
    });

    test("TestCoordinatorRunDispatchesRestoredNonTerminalOperations", async () => {
        const store = emptyFakeStore();
        const statuses: Status[] = ["ready", "awaiting", "canceling", "completed", "failed", "canceled"];

        for (const status of statuses) {
            store.resume.Operations.push({ ID: status, Type: TYPE_SHELL, Version: 1, Status: status });
        }

        const operations = new FakeOperationManager();
        const adapter = new FakeAdapter();
        const direct = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter, {
            operations,
            builder: newBuilder(),
        });
        // The Go test hands the coordinator an inbox whose context is already canceled.
        direct.inboxController.abort();

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe("inbox output closed");
        operations.adds.sort((left, right) => (left.ID < right.ID ? -1 : left.ID > right.ID ? 1 : 0));
        const want: Operation[] = [
            { ID: "awaiting", Type: TYPE_SHELL, Version: 1, Status: "awaiting" },
            { ID: "canceling", Type: TYPE_SHELL, Version: 1, Status: "canceling" },
            { ID: "ready", Type: TYPE_SHELL, Version: 1, Status: "ready" },
        ];
        expect(operations.adds).toEqual(want);
        expect(adapter.requests).toHaveLength(0);
    });

    test("TestCoordinatorRunReturnsOperationDispatchError", async () => {
        const store = emptyFakeStore();
        const value: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        store.resume.Operations = [value];
        const operations = new FakeOperationManager();
        operations.addError = () => new Error("dispatch failed");
        const direct = newTestCoordinator(store, newRegistry({}), { operations, builder: newBuilder() });

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('dispatch operation "operation-1": dispatch failed');
    });

    test("TestCoordinatorRunReturnsUnsupportedRecoveredOperation", async () => {
        const store = emptyFakeStore();
        store.resume.Operations = [
            { ID: "unsupported", Type: "remote", Version: 1, Status: "ready" },
            { ID: "supported", Type: TYPE_SHELL, Version: 1, Status: "ready" },
        ];
        const operations = new FakeOperationManager();
        operations.addError = (value) => {
            if (value.ID === "unsupported") {
                const unsupported = new UnsupportedOperationError();
                return new Error(`manager does not support "${value.Type}": ${unsupported.message}`, {
                    cause: unsupported,
                });
            }

            return null;
        };
        const direct = newTestCoordinator(store, newRegistry({}), { operations, builder: newBuilder() });
        // The Go test hands the coordinator an inbox whose context is already canceled.
        direct.inboxController.abort();

        const error = await runToEnd(direct);
        expect(errorChainHas(error, (link) => link instanceof UnsupportedOperationError)).toBe(true);
        // The unsupported operation must be retained.
        expect(direct.internals.operationStates().has("unsupported")).toBe(true);
    });

    test("TestCoordinatorClonesOperationDataBeforeDispatch", async () => {
        const operations = new MutatingOperationManager();
        operations.mutateAdds = true;
        const { current, internals } = newTestCoordinator(emptyFakeStore(), newRegistry({}), {
            operations,
            builder: newBuilder(),
        });
        const value = addOperationToLocalState(current, {
            ID: "operation-1",
            Type: TYPE_SHELL,
            Version: 1,
            Status: "ready",
            State: '{"state":"original"}',
            Idempotency: '{"key":"original"}',
        });

        await internals.dispatchOperationsToManager();
        const stored = internals.operationStates().get(value.ID);
        // The stored operation must not be mutated by the manager.
        expect(stored?.State).toBe('{"state":"original"}');
        expect(stored?.Idempotency).toBe('{"key":"original"}');
    });

    test("TestCoordinatorRunReturnsInputStoreErrorAfterUpdatingLocalState", async () => {
        const store = emptyFakeStore();
        store.appendInputErr = new Error("disk unavailable");
        const builder = newBuilder();
        const direct = newTestCoordinator(store, newRegistry({}), { operations: new FakeOperationManager(), builder });
        const event = externalEvent("input-1", "hello");
        await direct.inputs.submit(event);

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('store input "input-1": disk unavailable');
        const built = direct.deps.contextBuilder.build();
        const want = withPreamble({ Type: "message", Data: { Role: "user", Text: "hello" } });
        expect(built.Request.Input).toEqual(want);
    });

    test("TestCoordinatorRunReturnsOperationStoreErrorAfterUpdatingLocalState", async () => {
        const store = emptyFakeStore();
        store.saveOperationErr = new Error("disk unavailable");
        const operations = new FakeOperationManager();
        const update: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "awaiting" };
        operations.updateQueue.push(update);
        const direct = newTestCoordinator(store, newRegistry({}), { operations, builder: newBuilder() });

        const error = await runToEnd(direct);
        expect(error).toBeInstanceOf(Error);
        expect(errorMessage(error)).toBe('store operation "operation-1": disk unavailable');
        expect(direct.internals.operationStates().get(update.ID)).toEqual(update);
        // No operation may be dispatched before the store commit.
        expect(operations.adds).toHaveLength(0);
    });

    test("TestCoordinatorStoresEverySessionItemKind", async () => {
        const store = emptyFakeStore();
        const { current } = newTestCoordinator(store, newRegistry({}), {
            operations: new FakeOperationManager(),
            builder: newBuilder(),
        });
        const event = externalEvent("input-1", "hello");
        const turn: Turn = { ID: "turn-1", PreviousTurnID: "", Type: "regular" };
        const response: ModelResponse = {
            TurnID: turn.ID,
            Response: { ID: "response-1", Stop: "complete", Usage: usage() },
        };
        const value: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        addOperationToLocalState(current, value);
        const status: ToolCallStatus = {
            TurnID: turn.ID,
            CallID: "call-1",
            Status: { Error: "", WaitingFor: [value.ID] },
            Operations: [value],
        };
        const items: Item[] = [
            { Kind: "input", Data: event },
            { Kind: "turn", Data: turn },
            { Kind: "model_response", Data: response },
            { Kind: "tool_call_status", Data: status },
        ];

        for (const item of items) {
            await storeItemInSessionStore(current, item);
        }

        expect(store.appendedInputs).toEqual([event]);
        expect(store.appendedTurns).toEqual([turn]);
        expect(store.appendedResponses).toEqual([response]);
        expect(store.appendedStatuses).toEqual([status]);
    });

    test("TestCoordinatorReturnsSessionItemStoreErrors", async () => {
        const turn: Turn = { ID: "turn-1", PreviousTurnID: "", Type: "regular" };
        const response: ModelResponse = {
            TurnID: turn.ID,
            Response: { ID: "", Stop: "complete", Usage: usage() },
        };
        const status: ToolCallStatus = {
            TurnID: turn.ID,
            CallID: "call-1",
            Status: { Error: "", WaitingFor: ["operation-1"] },
        };
        const tests: Array<{
            name: string;
            item: Item;
            configure: (store: FakeStore, current: Coordinator) => void;
            want: string;
        }> = [
            {
                name: "turn",
                item: { Kind: "turn", Data: turn },
                configure: (store) => {
                    store.appendTurnErr = new Error("disk unavailable");
                },
                want: 'store turn "turn-1": disk unavailable',
            },
            {
                name: "model response",
                item: { Kind: "model_response", Data: response },
                configure: (store) => {
                    store.appendModelResponseErr = new Error("disk unavailable");
                },
                want: 'store turn "turn-1" response: disk unavailable',
            },
            {
                name: "tool status",
                item: { Kind: "tool_call_status", Data: status },
                configure: (store) => {
                    store.appendStatusErr = new Error("disk unavailable");
                },
                want: 'store tool call "call-1" status: disk unavailable',
            },
            {
                name: "unsupported item",
                item: { Kind: "fork", Data: { ParentID: "", PreviousTurnID: "" } },
                configure: () => {},
                want: 'unsupported local item kind "fork"',
            },
        ];

        for (const testCase of tests) {
            const store = emptyFakeStore();
            const { current } = newTestCoordinator(store, newRegistry({}), {
                operations: new FakeOperationManager(),
                builder: newBuilder(),
            });
            testCase.configure(store, current);

            let error: unknown;

            try {
                await storeItemInSessionStore(current, testCase.item);
            } catch (caught) {
                error = caught;
            }

            expect(error).toBeInstanceOf(Error);
            expect(errorMessage(error)).toBe(testCase.want);
        }
    });

    test("TestCoordinatorRunReturnsContextCancellation", async () => {
        const store = emptyFakeStore();
        const operations = new FakeOperationManager();
        const direct = newTestCoordinator(store, newRegistry({}), { operations, builder: newBuilder() });
        const run = new DirectRun(direct);
        await run.start();
        await drainTasks();
        const canceled = new AbortedError("canceled");
        run.cancel(canceled);
        expect(errorChainIncludes(await run.result(), canceled)).toBe(true);
    });

    test("TestClosedInputErrorPrefersContextCancellation", async () => {
        const { current } = newTestCoordinator(emptyFakeStore(), newRegistry({}));
        const controller = new AbortController();
        const canceled = new AbortedError("canceled");
        controller.abort(canceled);
        expect(errorChainIncludes(closedInputError(current, controller.signal, "input"), canceled)).toBe(true);
    });
});

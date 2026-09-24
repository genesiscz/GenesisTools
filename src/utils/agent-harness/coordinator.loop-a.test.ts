// Twins of harness/coordinator/loop_test.go, first half: TestCoordinatorRestoresSession through
// TestCoordinatorRunHandlesOperationUpdateWhileModelIsRunning.

import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "./async-queue";
import { AbortedError, drainTasks } from "./clock";
import { newBuilder } from "./contextbuilder";
import { HISTORY_PAGE_SIZE } from "./coordinator";
import type { Input } from "./inbox";
import type { Item as Item2, Request, Response, ToolCall } from "./llm";
import type { Operation } from "./operation";
import type { Item, ModelResponse, ToolCallStatus, Turn } from "./sessionstore";
import {
    BASH_NAME,
    emptyFakeStore,
    externalEvent,
    FailingResultTranslator,
    FakeAdapter,
    FakeOperationManager,
    FakeStore,
    independentToolCalls,
    newRegistry,
    newTestCoordinator,
    newTestCoordinatorWithAdapter,
    newValueSpec,
    OperationStatusTranslator,
    oracle,
    SubmittingTranslator,
    storedItem,
    TestTranslator,
    TYPE_SHELL,
    textResponse,
    VIEW_IMAGE_NAME,
    withPreamble,
} from "./testing/driver";
import {
    decodeUncheckedItem,
    errorsIs,
    modelResponse,
    receiveRunError,
    receiveTestValue,
    rejectionMessage,
    startRun,
    thrownMessage,
    toolCallMap,
    virtualClock,
} from "./testing/loop-a-helpers";
import { FailingBuilder } from "./testing/rest-helpers";
import type { CallStatus } from "./tool";

/** Go's `context.Canceled`: the reason every twin cancels its run with. */
function newCanceled(): AbortedError {
    return new AbortedError("context canceled");
}

/** `<-ctx.Done(); return llm.Response{}, ctx.Err()`, with a hook for what the adapter sees. */
function untilCanceled(signal: AbortSignal, onCanceled?: (error: unknown) => void): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
        const fire = () => {
            onCanceled?.(signal.reason);
            reject(signal.reason);
        };

        if (signal.aborted) {
            fire();
            return;
        }

        signal.addEventListener("abort", fire, { once: true });
    });
}

function userMessage(text: string): Item2 {
    return { Type: "message", Data: { Role: "user", Text: text } };
}

function turnItem(sequence: number, turn: Turn): Item {
    return storedItem(sequence, { Kind: "turn", Data: turn });
}

// White-box twins: they drive the coordinator's internals (`coordinatorInternals`), which the Go
// oracle cannot expose, so they run against the port only.
describe.skipIf(oracle)("loop_test.go (1/2)", () => {
    test("TestCoordinatorRestoresSession", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const input = externalEvent("input-1", "hello");
        const turn: Turn = { ID: "turn-1", PreviousTurnID: "", Type: "regular" };
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const response = modelResponse(
            [
                { Type: "message", Data: { Role: "assistant", Text: "working" } },
                { Type: "tool_call", Data: call },
            ],
            "response-1"
        );
        const status: ToolCallStatus = {
            TurnID: turn.ID,
            CallID: call.CallID,
            Status: { Error: "invalid arguments" },
        };
        const resumedOperation: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "awaiting" };
        const store = new FakeStore("session-1");
        store.resume.Operations = [resumedOperation];
        store.items = [
            storedItem(1, { Kind: "input", Data: input }),
            storedItem(2, { Kind: "turn", Data: turn }),
            storedItem(3, { Kind: "model_response", Data: { TurnID: turn.ID, Response: response } }),
            storedItem(4, { Kind: "tool_call_status", Data: status }),
        ];
        const builder = newBuilder();
        const current = newTestCoordinator(store, registry, { builder });

        await current.internals.restore();

        expect(current.internals.currentTurnID).toBe(turn.ID);
        expect(current.internals.currentTurnType).toBe("regular");
        expect(current.internals.operationStates().get(resumedOperation.ID)).toEqual(resumedOperation);

        const output = response.Output ?? [];
        const wantInput = withPreamble(userMessage("hello"), output[0], output[1], {
            Type: "tool_result",
            Data: { CallID: call.CallID, Output: [{ Kind: "text", Value: "error:invalid arguments" }] },
        });
        expect(builder.build().Request.Input).toEqual(wantInput);
        expect(store.itemRequests).toEqual([{ After: 0, Limit: HISTORY_PAGE_SIZE }]);
    });

    test("TestCoordinatorAppliesTurnTypes", () => {
        // Go: newStopTestRun(t, 0).current, a coordinator built before Run starts.
        const { store, registry } = independentToolCalls(0);
        const current = newTestCoordinator(store, registry);

        for (const turnType of ["regular", "compaction", "regular", "compaction"] as const) {
            const turn: Turn = { ID: "turn", PreviousTurnID: "", Type: turnType };
            current.internals.addItemToLocalState({ Kind: "turn", Data: turn });
            expect(current.internals.currentTurnType).toBe(turnType);
        }
    });

    test("TestCoordinatorRestoresOrdinaryResponseDuringCompaction", async () => {
        const { store, registry } = independentToolCalls(0);
        const current = newTestCoordinator(store, registry);
        const response = textResponse("Ordinary response");
        response.Output = [
            ...(response.Output ?? []),
            { Type: "tool_call", Data: { CallID: "old-call", Name: "unknown", Arguments: "" } },
        ];
        store.items = [
            storedItem(1, { Kind: "input", Data: externalEvent("input", "hello") }),
            turnItem(2, { ID: "ordinary", PreviousTurnID: "", Type: "regular" }),
            turnItem(3, { ID: "compact", PreviousTurnID: "ordinary", Type: "compaction" }),
            storedItem(4, { Kind: "model_response", Data: { TurnID: "ordinary", Response: response } }),
        ];

        await current.internals.loadHistory();

        const want = [...withPreamble(userMessage("hello")), ...(response.Output ?? [])];
        // Go: "earlier ordinary response was lost or treated as a compaction response".
        expect(current.builder.build().Request.Input).toEqual(want);
        expect(current.internals.currentTurnType).toBe("compaction");
        expect(current.internals.pendingInputs()).toBe(1);
        expect(current.internals.toolCallStates()).toHaveLength(1);
    });

    test("TestCoordinatorRestoresPaginatedForkHistory", async () => {
        const parentInput = externalEvent("parent-input", "parent");
        const items: Item[] = [storedItem(1, { Kind: "input", Data: parentInput })];

        for (let sequence = 2; sequence <= HISTORY_PAGE_SIZE; sequence++) {
            items.push(turnItem(sequence, { ID: `turn-${sequence}`, PreviousTurnID: "", Type: "regular" }));
        }

        items.push(
            storedItem(HISTORY_PAGE_SIZE + 1, {
                Kind: "fork",
                Data: { ParentID: "parent", PreviousTurnID: "turn-256" },
            }),
            storedItem(HISTORY_PAGE_SIZE + 2, { Kind: "input", Data: externalEvent("child-input", "child") })
        );
        const store = new FakeStore("session-1");
        store.items = items;
        const builder = newBuilder();
        const current = newTestCoordinator(store, newRegistry({}), { builder });

        await current.internals.restore();

        expect(store.itemRequests).toEqual([
            { After: 0, Limit: HISTORY_PAGE_SIZE },
            { After: HISTORY_PAGE_SIZE, Limit: HISTORY_PAGE_SIZE },
        ]);
        expect(current.internals.currentTurnID).toBe("turn-256");
        const want = withPreamble(userMessage("parent"), userMessage("child"));
        expect(builder.build().Request.Input).toEqual(want);
    });

    test("TestCoordinatorReturnsSessionHistoryError", async () => {
        const store = emptyFakeStore();
        store.itemsErr = new Error("disk unavailable");
        const current = newTestCoordinator(store, newRegistry({}));

        const message = await rejectionMessage(current.current.run(new AbortController().signal));
        expect(message).toBe("load session history after 0: disk unavailable");
    });

    test("TestCoordinatorRejectsSessionHistoryWithoutProgress", async () => {
        const store = emptyFakeStore();
        store.itemsPage = { Items: [], More: true, NextAfter: 0 };
        const current = newTestCoordinator(store, newRegistry({}));

        const message = await rejectionMessage(current.internals.restore());
        expect(message).toBe("load session history did not advance after 0");
    });

    test("TestCoordinatorKeepsUnreplayableToolStatusInLocalState", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const turn: Turn = { ID: "turn-1", PreviousTurnID: "", Type: "regular" };
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const status: ToolCallStatus = {
            TurnID: turn.ID,
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: ["terminal-operation"] },
        };
        const store = new FakeStore("session-1");
        store.items = [
            storedItem(1, { Kind: "turn", Data: turn }),
            storedItem(2, {
                Kind: "model_response",
                Data: { TurnID: turn.ID, Response: modelResponse([{ Type: "tool_call", Data: call }]) },
            }),
            storedItem(3, { Kind: "tool_call_status", Data: status }),
        ];
        const builder = newBuilder();
        const current = newTestCoordinator(store, registry, { builder });

        await current.internals.restore();

        const callState = toolCallMap(current.internals)[`${status.TurnID}/${status.CallID}`];
        expect(callState).toBeDefined();
        expect(callState?.status).toBeDefined();
        expect(callState?.status).toEqual(status.Status);
        expect(builder.build().Request.Input).toEqual(withPreamble({ Type: "tool_call", Data: call }));
    });

    test("TestCoordinatorRestoresCompletedToolCallFromStatusSnapshots", async () => {
        const registry = newRegistry({ ViewImage: new OperationStatusTranslator() }, VIEW_IMAGE_NAME);
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const initial: Operation = { ID: "operation-1", Type: "test", Version: 1, Status: "ready" };
        const completed: Operation = { ...initial, Status: "completed" };
        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: [initial.ID] },
        };
        const initialStatus: ToolCallStatus = { ...status, Operations: [initial] };
        const completedStatus: ToolCallStatus = { ...status, Operations: [completed] };
        const store = new FakeStore("session-1");
        store.items = [
            turnItem(1, { ID: "turn-1", PreviousTurnID: "", Type: "regular" }),
            storedItem(2, {
                Kind: "model_response",
                Data: { TurnID: "turn-1", Response: modelResponse([{ Type: "tool_call", Data: call }]) },
            }),
            storedItem(3, { Kind: "tool_call_status", Data: initialStatus }),
            storedItem(4, { Kind: "tool_call_status", Data: completedStatus }),
        ];
        const builder = newBuilder();
        const current = newTestCoordinator(store, registry, { builder });

        await current.internals.restore();

        // Go: "completed tool call remains in local state".
        expect(toolCallMap(current.internals)[`turn-1/${call.CallID}`]).toBeUndefined();
        expect(current.internals.operationStates().get(completed.ID)).toEqual(completed);
        const want = withPreamble(
            { Type: "tool_call", Data: call },
            { Type: "tool_result", Data: { CallID: call.CallID, Output: [{ Kind: "text", Value: "completed" }] } }
        );
        expect(builder.build().Request.Input).toEqual(want);
    });

    test("TestCoordinatorOverlaysResumedOperationsAfterHistorySnapshots", async () => {
        const registry = newRegistry({ ViewImage: new OperationStatusTranslator() }, VIEW_IMAGE_NAME);
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const first: Operation = { ID: "operation-1", Type: "test", Version: 1, Status: "ready" };
        const second: Operation = { ID: "operation-2", Type: "test", Version: 1, Status: "ready" };
        const resumedSecond: Operation = { ...second, Status: "awaiting" };
        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: [first.ID, second.ID] },
            Operations: [first, second],
        };
        const store = new FakeStore("session-1");
        store.resume.Operations = [resumedSecond];
        store.items = [
            turnItem(1, { ID: "turn-1", PreviousTurnID: "", Type: "regular" }),
            storedItem(2, {
                Kind: "model_response",
                Data: { TurnID: "turn-1", Response: modelResponse([{ Type: "tool_call", Data: call }]) },
            }),
            storedItem(3, { Kind: "tool_call_status", Data: status }),
        ];
        const operations = new FakeOperationManager();
        const current = newTestCoordinator(store, registry, { operations });

        await current.internals.restore();

        const restored = current.internals.operationStates();
        expect(restored.get(first.ID)).toEqual(first);
        expect(restored.get(second.ID)).toEqual(resumedSecond);

        await current.internals.dispatchOperationsToManager();

        const want: Record<string, Operation> = { [first.ID]: first, [second.ID]: resumedSecond };
        const got: Record<string, Operation> = {};

        for (const value of operations.adds) {
            got[value.ID] = value;
        }

        expect(got).toEqual(want);
    });

    test("TestCoordinatorTracksToolCalls", () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const current = newTestCoordinator(emptyFakeStore(), registry);
        const first: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        const second: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: '{"second":true}' };
        const responses: ModelResponse[] = [
            {
                TurnID: "turn-1",
                Response: modelResponse([
                    { Type: "message", Data: { Role: "assistant", Text: "working" } },
                    { Type: "tool_call", Data: first },
                ]),
            },
            {
                TurnID: "turn-2",
                Response: modelResponse([{ Type: "tool_call", Data: second }]),
            },
        ];

        for (const response of responses) {
            current.internals.addItemToLocalState({ Kind: "model_response", Data: response });
        }

        expect(toolCallMap(current.internals)).toEqual({
            [`turn-1/${first.CallID}`]: { toolCall: first, operations: [] },
            [`turn-2/${second.CallID}`]: { toolCall: second, operations: [] },
        });

        current.internals.addItemToLocalState({
            Kind: "tool_call_status",
            Data: { TurnID: "turn-1", CallID: first.CallID, Status: { Error: "invalid arguments" } },
        });
        expect(toolCallMap(current.internals)).toEqual({
            [`turn-2/${second.CallID}`]: { toolCall: second, operations: [] },
        });

        const waitingFor = ["operation-1", "operation-2"];
        const waitingStatus: CallStatus = { Error: "", WaitingFor: waitingFor };
        current.internals.addItemToLocalState({
            Kind: "tool_call_status",
            Data: { TurnID: "turn-2", CallID: second.CallID, Status: waitingStatus },
        });
        expect(toolCallMap(current.internals)).toEqual({
            [`turn-2/${second.CallID}`]: {
                toolCall: second,
                status: waitingStatus,
                operations: [waitingFor[0], waitingFor[1]],
            },
        });
    });

    test("TestCoordinatorToolCallOperationsAreTerminal", async () => {
        // Go builds `&coordinator{state: newLoopState()}` and writes `state.toolCalls[key]` by hand.
        // The port reaches the same state through its own entry points: a model response tracks
        // the call, and a status for a tool with no translator records the awaited operations
        // without producing a result.
        const current = newTestCoordinator(emptyFakeStore(), newRegistry({}));
        expect(current.internals.toolCallOperationsAreTerminal("missing-turn", "missing-call")).toBe(true);

        const key = { turnID: "turn-1", callID: "call-1" };
        current.internals.addItemToLocalState({
            Kind: "model_response",
            Data: {
                TurnID: key.turnID,
                Response: modelResponse([
                    { Type: "tool_call", Data: { CallID: key.callID, Name: VIEW_IMAGE_NAME, Arguments: "{}" } },
                ]),
            },
        });
        current.internals.addItemToLocalState({
            Kind: "tool_call_status",
            Data: {
                TurnID: key.turnID,
                CallID: key.callID,
                Status: { Error: "", WaitingFor: ["completed", "failed", "canceled"] },
            },
        });

        // Go: current.addOperationToLocalState(...). handleOperationUpdate is that plus a store
        // write the fake store absorbs.
        const terminal: Array<[string, Operation["Status"]]> = [
            ["completed", "completed"],
            ["failed", "failed"],
            ["canceled", "canceled"],
        ];

        for (const [id, status] of terminal) {
            await current.internals.handleOperationUpdate({ ID: id, Type: "", Version: 0, Status: status });
        }

        expect(current.internals.toolCallOperationsAreTerminal(key.turnID, key.callID)).toBe(true);

        await current.internals.handleOperationUpdate({ ID: "failed", Type: "", Version: 0, Status: "awaiting" });
        expect(current.internals.toolCallOperationsAreTerminal(key.turnID, key.callID)).toBe(false);
    });

    test("TestCoordinatorAddsToolResultFromTrackedToolCall", () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const builder = newBuilder();
        const current = newTestCoordinator(emptyFakeStore(), registry, { builder });
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        current.internals.addToolCallsToLocalState({
            TurnID: "turn-1",
            Response: modelResponse([{ Type: "tool_call", Data: call }]),
        });

        current.internals.addToolResultToLocalState({
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "invalid arguments" },
        });

        const want = withPreamble({
            Type: "tool_result",
            Data: { CallID: call.CallID, Output: [{ Kind: "text", Value: "error:invalid arguments" }] },
        });
        expect(builder.build().Request.Input).toEqual(want);
    });

    test("TestCoordinatorAcceptsOrphanedToolStatus", () => {
        const current = newTestCoordinator(emptyFakeStore(), newRegistry({}));
        const status: ToolCallStatus = {
            TurnID: "turn-1",
            CallID: "missing-call",
            Status: { Error: "", WaitingFor: ["operation-1"] },
        };

        const item = current.internals.addItemToLocalState({ Kind: "tool_call_status", Data: status });
        expect(item.Data).toEqual(status);
    });

    test("TestCoordinatorReturnsToolResultTranslationError", () => {
        const registry = newRegistry(
            { ViewImage: new FailingResultTranslator(new Error("translation failed")) },
            VIEW_IMAGE_NAME
        );
        const builder = newBuilder();
        const current = newTestCoordinator(emptyFakeStore(), registry, { builder });
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        current.internals.addToolCallsToLocalState({
            TurnID: "turn-1",
            Response: modelResponse([{ Type: "tool_call", Data: call }]),
        });

        const message = thrownMessage(() =>
            current.internals.addItemToLocalState({
                Kind: "tool_call_status",
                Data: { TurnID: "turn-1", CallID: call.CallID, Status: { Error: "" } },
            })
        );
        expect(message).toBe('add tool call "call-1" result to context: translation failed');
    });

    test("TestCoordinatorSkipsToolResultWithoutAvailableTranslator", () => {
        const builder = newBuilder();
        const current = newTestCoordinator(emptyFakeStore(), newRegistry({}), { builder });
        const call: ToolCall = { CallID: "call-1", Name: "unavailable-tool", Arguments: "" };
        current.internals.addToolCallsToLocalState({
            TurnID: "turn-1",
            Response: modelResponse([{ Type: "tool_call", Data: call }]),
        });

        current.internals.addToolResultToLocalState({ TurnID: "turn-1", CallID: call.CallID, Status: { Error: "" } });
        // Go: "tool call with unavailable translator was removed".
        expect(toolCallMap(current.internals)[`turn-1/${call.CallID}`]).toBeDefined();
    });

    test("TestCoordinatorSkipsToolResultWithUntrackedOperation", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const builder = newBuilder();
        const current = newTestCoordinator(emptyFakeStore(), registry, { builder });
        const call: ToolCall = { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "" };
        current.internals.addToolCallsToLocalState({
            TurnID: "turn-1",
            Response: modelResponse([{ Type: "tool_call", Data: call }]),
        });
        // Go: current.addOperationToLocalState(...); see TestCoordinatorToolCallOperationsAreTerminal.
        await current.internals.handleOperationUpdate({ ID: "operation-1", Type: "", Version: 0, Status: "completed" });

        current.internals.addToolResultToLocalState({
            TurnID: "turn-1",
            CallID: call.CallID,
            Status: { Error: "", WaitingFor: ["operation-1"] },
        });
        // Go: "tool call with an untracked operation was removed".
        expect(toolCallMap(current.internals)[`turn-1/${call.CallID}`]).toBeDefined();
    });

    test("TestCoordinatorKeepsControlInputWithoutContextProjection", async () => {
        const input: Input = { ID: "control-input", Kind: "control", Payload: '{"Mode":"when_idle"}' };
        const store = new FakeStore("session-1");
        store.items = [storedItem(1, { Kind: "input", Data: input })];
        const builder = newBuilder();
        const current = newTestCoordinator(store, newRegistry({}), { builder });

        await current.internals.restore();

        expect(builder.build().Request.Input).toEqual(withPreamble());
    });

    test("TestCoordinatorRejectsInvalidSessionItemData", async () => {
        // Go stores a `session.Turn` or an `inbox.Input` as the Data of an item of another kind; the
        // port's union cannot express that in typed code, so the items come from unchecked JSON and
        // the coordinator's runtime shape check (`assertItemData`) fails them like Go's assertion.
        const turnData = '{"ID":"","PreviousTurnID":"","Type":""}';
        const inputData = '{"ID":"","Kind":""}';
        const tests = [
            {
                name: "fork",
                item: decodeUncheckedItem(`{"Sequence":1,"Kind":"fork","Data":${turnData}}`),
                want: "want sessionstore.Fork",
            },
            {
                name: "input",
                item: decodeUncheckedItem(`{"Sequence":1,"Kind":"input","Data":${turnData}}`),
                want: "want inbox.Input",
            },
            {
                name: "invalid input",
                item: decodeUncheckedItem('{"Sequence":1,"Kind":"input","Data":{"ID":"input-1","Kind":"unknown"}}'),
                want: "invalid input",
            },
            {
                name: "turn",
                item: decodeUncheckedItem(`{"Sequence":1,"Kind":"turn","Data":${inputData}}`),
                want: "want session.Turn",
            },
            {
                name: "response",
                item: decodeUncheckedItem(`{"Sequence":1,"Kind":"model_response","Data":${turnData}}`),
                want: "want sessionstore.ModelResponse",
            },
            {
                name: "status",
                item: decodeUncheckedItem(`{"Sequence":1,"Kind":"tool_call_status","Data":${turnData}}`),
                want: "want sessionstore.ToolCallStatus",
            },
            {
                name: "kind",
                item: decodeUncheckedItem('{"Sequence":1,"Kind":"unknown","Data":null}'),
                want: 'unsupported item kind "unknown"',
            },
        ];

        for (const entry of tests) {
            const store = new FakeStore("session-1");
            store.items = [entry.item];
            const current = newTestCoordinator(store, newRegistry({}));
            const message = await rejectionMessage(current.internals.restore());
            expect(message, entry.name).not.toBeNull();
            expect(message ?? "", entry.name).toContain(entry.want);
        }
    });

    test("TestCoordinatorRunCallsModelAfterPersistedExternalInput", async () => {
        const store = emptyFakeStore();
        store.items = [turnItem(1, { ID: "previous-turn", PreviousTurnID: "", Type: "regular" })];
        const operations = new FakeOperationManager();
        const started = new AsyncQueue<Request>();
        const requestCanceled = new AsyncQueue<unknown>();
        const order: string[] = [];
        store.onAppendInput = () => {
            order.push("input");
        };
        store.onAppendTurn = () => {
            order.push("turn");
        };
        const adapter = new FakeAdapter((request, signal) => {
            order.push("respond");
            started.push(request);
            return untilCanceled(signal, (error) => requestCanceled.push(error));
        });
        const builder = newBuilder();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter, { builder, operations });
        const clock = virtualClock(current);
        const controller = new AbortController();
        const done = startRun(current, controller.signal);

        const event = externalEvent("input-1", "hello");
        await current.inputs.submit(event);
        const request = await receiveTestValue(clock, started);
        const built = builder.build();
        const want = withPreamble(userMessage("hello"));
        expect(built.Request.Input).toEqual(want);
        expect(request).toEqual(built.Request);
        expect(store.appendedInputs).toEqual([event]);
        expect(store.appendedTurns).toHaveLength(1);
        expect(store.appendedTurns[0].ID).not.toBe("");
        expect(store.appendedTurns[0].PreviousTurnID).toBe("previous-turn");
        expect(order).toEqual(["input", "turn", "respond"]);
        expect(operations.adds).toHaveLength(0);
        expect(operations.cancels).toHaveLength(0);

        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(errorsIs(await receiveTestValue(clock, requestCanceled), canceled)).toBe(true);
    });

    test("TestCoordinatorRunSlurpsQueuedInputsBeforeCallingModel", async () => {
        const store = emptyFakeStore();
        const first = externalEvent("input-1", "first");
        const second = externalEvent("input-2", "second");
        const started = new AsyncQueue<Request>();
        const adapter = new FakeAdapter((request, signal) => {
            started.push(request);
            return untilCanceled(signal);
        });
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter);
        await current.inputs.submit(first);
        await current.inputs.submit(second);
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        const request = await receiveTestValue(clock, started);
        const want = withPreamble(userMessage("first"), userMessage("second"));
        expect(request.Input).toEqual(want);
        expect(store.appendedInputs).toEqual([first, second]);
        expect(adapter.requests).toHaveLength(1);

        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
    });

    test("TestCoordinatorRunDoesNotCallModelWhenRequestBuildFails", async () => {
        const store = emptyFakeStore();
        const adapter = new FakeAdapter();
        const builder = new FailingBuilder(newBuilder(), new Error("context unavailable"));
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter, { builder });
        const clock = virtualClock(current);
        const done = startRun(current, new AbortController().signal);

        const event = externalEvent("input-1", "hello");
        await current.inputs.submit(event);
        const error = await receiveRunError(clock, done);
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : String(error)).toBe("build model request: context unavailable");
        // Go: "effects after build failure".
        expect(store.appendedInputs).toEqual([event]);
        expect(store.appendedTurns).toHaveLength(0);
        expect(adapter.requests).toHaveLength(0);
    });

    test("TestCoordinatorRunDoesNotCallModelWhenTurnStoreFails", async () => {
        const store = emptyFakeStore();
        store.appendTurnErr = new Error("disk unavailable");
        const adapter = new FakeAdapter();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter);
        const clock = virtualClock(current);
        const done = startRun(current, new AbortController().signal);

        await current.inputs.submit(externalEvent("input-1", "hello"));
        const error = await receiveRunError(clock, done);
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : String(error)).toContain("disk unavailable");
        // Go: "effects after turn store failure".
        expect(store.appendedTurns).toHaveLength(1);
        expect(adapter.requests).toHaveLength(0);
    });

    test("TestCoordinatorRunPersistsModelResponseForOriginatingTurn", async () => {
        const store = emptyFakeStore();
        const responseStored = new AsyncQueue<ModelResponse>();
        store.onAppendModelResponse = (response) => {
            responseStored.push(response);
        };
        const response = modelResponse([{ Type: "message", Data: { Role: "assistant", Text: "done" } }], "response-1");
        const adapter = new FakeAdapter(async () => response);
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter);
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "hello"));
        const stored = await receiveTestValue(clock, responseStored);
        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(store.appendedTurns).toHaveLength(1);
        expect(stored.TurnID).toBe(store.appendedTurns[0].ID);
        expect(stored.Response).toEqual(response);
        // Go: "message response effects".
        expect(adapter.requests).toHaveLength(1);
        expect(store.appendedResponses).toHaveLength(1);
        expect(store.appendedTurns).toHaveLength(1);
    });

    test("TestCoordinatorRunPersistsToolCallBeforeDispatch", async () => {
        const spec = newValueSpec('{"value":1}');
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        const store = emptyFakeStore();
        const dispatched = new AsyncQueue<Operation>();
        const operations = new FakeOperationManager();
        operations.addError = (value) => {
            if (store.appendedResponses.length !== 1 || store.appendedStatuses.length !== 1) {
                return new Error("operation dispatched before response and status were stored");
            }

            dispatched.push(value);
            return null;
        };
        const response = modelResponse(
            [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
            "response-1"
        );
        const adapter = new FakeAdapter(async () => response);
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({ Bash: translator }, BASH_NAME), adapter, {
            operations,
        });
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "run"));
        const operationValue = await receiveTestValue(clock, dispatched);
        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(store.appendedStatuses).toHaveLength(1);
        expect(store.appendedStatuses[0].Operations).toEqual([operationValue]);
        expect(store.appendedStatuses[0].Status.WaitingFor).toEqual([operationValue.ID]);
        expect(adapter.requests).toHaveLength(1);
        expect(store.appendedTurns).toHaveLength(1);
    });

    test("TestCoordinatorRunStartsCorrectiveTurnForValidationError", async () => {
        const firstResponse = modelResponse(
            [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
            "response-1"
        );
        const started = new AsyncQueue<Request>();
        let callCount = 0;
        const adapter = new FakeAdapter(async (request, signal) => {
            callCount++;
            started.push(request);

            if (callCount === 1) {
                return firstResponse;
            }

            return untilCanceled(signal);
        });
        const store = emptyFakeStore();
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}, BASH_NAME), adapter);
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "run"));
        const firstRequest = await receiveTestValue(clock, started);
        const secondRequest = await receiveTestValue(clock, started);
        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(store.appendedStatuses).toHaveLength(1);
        expect(store.appendedStatuses[0].Status.Error).not.toBe("");
        expect(store.appendedTurns).toHaveLength(2);
        expect(store.appendedTurns[1].PreviousTurnID).toBe(store.appendedTurns[0].ID);
        expect(firstRequest.Input).toHaveLength(2);
        expect(secondRequest.Input).toHaveLength(4);
        expect(secondRequest.Input[3].Type).toBe("tool_result");
    });

    test("TestCoordinatorRunStartsContinuationTurnForCompletedToolCall", async () => {
        const spec = newValueSpec('{"value":1}');
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        const firstResponse = modelResponse(
            [{ Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } }],
            "response-1"
        );
        const started = new AsyncQueue<Request>();
        let callCount = 0;
        const adapter = new FakeAdapter(async (request, signal) => {
            callCount++;
            started.push(request);

            if (callCount === 1) {
                return firstResponse;
            }

            return untilCanceled(signal);
        });
        const store = emptyFakeStore();
        const operations = new FakeOperationManager();
        const dispatched = new AsyncQueue<Operation>();
        operations.addError = (value) => {
            dispatched.push(value);
            return null;
        };
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({ Bash: translator }, BASH_NAME), adapter, {
            operations,
        });
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "run"));
        await receiveTestValue(clock, started);
        const dispatchedValue = await receiveTestValue(clock, dispatched);
        const operationValue: Operation = { ...dispatchedValue, Status: "completed" };
        operations.updateQueue.push(operationValue);
        const continuationRequest = await receiveTestValue(clock, started);
        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        // Go: "completion effects".
        expect(store.savedOperations).toEqual([operationValue]);
        expect(store.appendedStatuses).toHaveLength(2);
        expect(store.appendedStatuses[1].Operations).toEqual([operationValue]);
        const options = adapter.requestOptions;
        // Go: "want session-1 cache keys for both turns".
        expect(options).toHaveLength(2);
        expect(options[0].CacheKey).toBe("session-1");
        expect(options[1].CacheKey).toBe("session-1");
        expect(continuationRequest.Input).toHaveLength(4);
        expect(continuationRequest.Input[3].Type).toBe("tool_result");
        expect(adapter.requests).toHaveLength(2);
        expect(store.appendedTurns).toHaveLength(2);
    });

    test("TestCoordinatorRunBatchesCompletedToolCallsIntoOneTurn", async () => {
        const registry = newRegistry({ ViewImage: new TestTranslator() }, VIEW_IMAGE_NAME);
        const operationValue: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        const calls: ToolCall[] = [
            { CallID: "call-1", Name: VIEW_IMAGE_NAME, Arguments: "{}" },
            { CallID: "call-2", Name: VIEW_IMAGE_NAME, Arguments: "{}" },
        ];
        const status: CallStatus = { Error: "", WaitingFor: [operationValue.ID] };
        const store = emptyFakeStore();
        store.resume.Operations = [operationValue];
        store.items = [
            turnItem(1, { ID: "turn-1", PreviousTurnID: "", Type: "regular" }),
            storedItem(2, {
                Kind: "model_response",
                Data: {
                    TurnID: "turn-1",
                    Response: modelResponse([
                        { Type: "tool_call", Data: calls[0] },
                        { Type: "tool_call", Data: calls[1] },
                    ]),
                },
            }),
            storedItem(3, {
                Kind: "tool_call_status",
                Data: { TurnID: "turn-1", CallID: calls[0].CallID, Status: status, Operations: [operationValue] },
            }),
            storedItem(4, {
                Kind: "tool_call_status",
                Data: { TurnID: "turn-1", CallID: calls[1].CallID, Status: status, Operations: [operationValue] },
            }),
        ];
        const started = new AsyncQueue<Request>();
        const adapter = new FakeAdapter((request, signal) => {
            started.push(request);
            return untilCanceled(signal);
        });
        const operations = new FakeOperationManager();
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, registry, adapter, { operations });
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        // Go assigns to its local copy; the resumed value in the store keeps its "ready" status.
        operations.updateQueue.push({ ...operationValue, Status: "completed" });
        const request = await receiveTestValue(clock, started);
        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(store.appendedStatuses).toHaveLength(2);
        expect(store.appendedTurns).toHaveLength(1);
        expect(store.appendedTurns[0].PreviousTurnID).toBe("turn-1");
        expect(adapter.requests).toHaveLength(1);
        expect(request.Input).toHaveLength(5);
    });

    test("TestCoordinatorRunSteersActiveModelRequest", async () => {
        const started = new AsyncQueue<Request>();
        const firstCanceled = new AsyncQueue<true>();
        const adapter = new FakeAdapter((request, signal) => {
            started.push(request);
            return untilCanceled(signal, () => {
                if (request.Input.length === 2) {
                    firstCanceled.push(true);
                }
            });
        });
        const store = emptyFakeStore();
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter);
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "first"));
        const firstRequest = await receiveTestValue(clock, started);
        await current.inputs.submit(externalEvent("input-2", "second"));
        const secondRequest = await receiveTestValue(clock, started);
        await receiveTestValue(clock, firstCanceled);
        // Go: select on done against time.After(20 * time.Millisecond).
        await drainTasks();
        await clock.advance(20);
        await drainTasks();

        if (done.settled) {
            throw new Error(`Run stopped after superseded cancellation: ${String(done.error)}`);
        }

        expect(firstRequest.Input).toHaveLength(2);
        expect(secondRequest.Input).toHaveLength(3);
        expect(store.appendedTurns).toHaveLength(2);
        expect(store.appendedTurns[1].PreviousTurnID).toBe(store.appendedTurns[0].ID);
        expect(store.appendedResponses).toHaveLength(0);

        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
    });

    test("TestCoordinatorRunHandlesOperationUpdateWhileModelIsRunning", async () => {
        const started = new AsyncQueue<true>();
        const adapter = new FakeAdapter((_request, signal) => {
            started.push(true);
            return untilCanceled(signal);
        });
        const initial: Operation = { ID: "operation-1", Type: TYPE_SHELL, Version: 1, Status: "ready" };
        const store = emptyFakeStore();
        store.resume.Operations = [initial];
        const storedUpdate = new AsyncQueue<Operation>();
        store.onSaveOperation = (value) => {
            storedUpdate.push(value);
        };
        const operations = new FakeOperationManager();
        const controller = new AbortController();
        const current = newTestCoordinatorWithAdapter(store, newRegistry({}), adapter, { operations });
        const clock = virtualClock(current);
        const done = startRun(current, controller.signal);

        await current.inputs.submit(externalEvent("input-1", "hello"));
        await receiveTestValue(clock, started);
        const update: Operation = { ...initial, Status: "awaiting" };
        operations.updateQueue.push(update);
        expect(await receiveTestValue(clock, storedUpdate)).toEqual(update);

        const canceled = newCanceled();
        controller.abort(canceled);
        expect(errorsIs(await receiveRunError(clock, done), canceled)).toBe(true);
        expect(adapter.requests).toHaveLength(1);
        expect(store.appendedTurns).toHaveLength(1);
    });
});

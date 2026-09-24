// Twins of harness/coordinator/delivery_test.go.

import { describe, expect, test } from "bun:test";
import { newBuilder } from "./contextbuilder";
import type { Item, ModelResponse, ToolCallStatus } from "./sessionstore";
import {
    externalEvent,
    independentToolCalls,
    newStopTestRun,
    newTestCoordinator,
    storedItem,
    textResponse,
} from "./testing/driver";
import { LocalStore, stateSnapshot, statusAt, storeItemInSessionStore } from "./testing/rest-helpers";

describe("delivery_test.go", () => {
    test("TestCoordinatorReplaysToolResultBalance", async () => {
        const { store, registry } = independentToolCalls(2);
        store.resume.Operations = [];
        const completion = (index: number): ToolCallStatus => {
            const status = statusAt(store.items, index + 2);
            const value = { ...(status.Operations ?? [])[0], Status: "completed" as const };
            return { ...status, Operations: [value] };
        };
        const first = completion(0);
        const second = completion(1);
        const steps: Array<{
            name: string;
            item: Item;
            pendingCalls: number;
            completed: number;
            delivered: number;
            pendingResults: number;
        }> = [
            {
                name: "first completion",
                item: { Kind: "tool_call_status", Data: first },
                pendingCalls: 1,
                completed: 1,
                delivered: 0,
                pendingResults: 1,
            },
            {
                name: "request starts",
                item: { Kind: "turn", Data: { ID: "delivery-1", PreviousTurnID: "turn-1", Type: "regular" } },
                pendingCalls: 1,
                completed: 1,
                delivered: 0,
                pendingResults: 1,
            },
            {
                name: "second completes during request",
                item: { Kind: "tool_call_status", Data: second },
                pendingCalls: 0,
                completed: 2,
                delivered: 0,
                pendingResults: 2,
            },
            {
                name: "duplicate completion",
                item: { Kind: "tool_call_status", Data: second },
                pendingCalls: 0,
                completed: 2,
                delivered: 0,
                pendingResults: 2,
            },
            {
                name: "request completes",
                item: { Kind: "model_response", Data: { TurnID: "delivery-1", Response: textResponse("Checking.") } },
                pendingCalls: 0,
                completed: 2,
                delivered: 1,
                pendingResults: 1,
            },
            {
                name: "next request starts",
                item: { Kind: "turn", Data: { ID: "delivery-2", PreviousTurnID: "delivery-1", Type: "regular" } },
                pendingCalls: 0,
                completed: 2,
                delivered: 1,
                pendingResults: 1,
            },
            {
                name: "next request completes",
                item: { Kind: "model_response", Data: { TurnID: "delivery-2", Response: textResponse("Done.") } },
                pendingCalls: 0,
                completed: 2,
                delivered: 2,
                pendingResults: 0,
            },
        ];

        for (const step of steps) {
            store.items.push(storedItem(store.items.length + 1, step.item));
            const current = newTestCoordinator(store, registry, { builder: newBuilder() });
            await current.internals.restore();
            // Go reads state.availableInputs; the internals expose pendingInputs() = available - delivered.
            const available = current.internals.pendingInputs() + current.internals.deliveredInputs;
            expect({ step: step.name, pendingCalls: current.internals.toolCallStates().length }).toEqual({
                step: step.name,
                pendingCalls: step.pendingCalls,
            });
            expect({ step: step.name, completed: available }).toEqual({ step: step.name, completed: step.completed });
            const built = current.builder.build();
            let appended = 0;

            for (const item of built.Request.Input) {
                if (item.Type === "tool_result" && item.Data.Output[0]?.Value === "completed") {
                    appended++;
                }
            }

            // appended completions = available inputs
            expect({ step: step.name, appended }).toEqual({ step: step.name, appended: available });
            expect({ step: step.name, delivered: current.internals.deliveredInputs }).toEqual({
                step: step.name,
                delivered: step.delivered,
            });
            expect({ step: step.name, pendingResults: current.internals.pendingInputs() }).toEqual({
                step: step.name,
                pendingResults: step.pendingResults,
            });
        }
    });

    test("TestCoordinatorCompactionPreservesPendingInputsOnReplay", async () => {
        const run = newStopTestRun(2);
        // Go uses the unstarted `run.current`: a coordinator over the run's fake store and registry.
        const { registry } = independentToolCalls(2);
        const current = newTestCoordinator(run.store, registry);
        const store = new LocalStore();
        await store.create("session-1");
        current.deps.sessions = store;
        const status = statusAt(run.store.items, 2);
        const completed = { ...(status.Operations ?? [])[0], Status: "completed" as const };
        const completedStatus: ToolCallStatus = { ...status, Operations: [completed] };
        const items: Item[] = [
            ...run.store.items,
            { Kind: "input", Data: externalEvent("before", "Before compaction") },
            { Kind: "turn", Data: { ID: "compact", PreviousTurnID: "turn-1", Type: "compaction" } },
            { Kind: "input", Data: externalEvent("during", "During compaction") },
            { Kind: "tool_call_status", Data: completedStatus },
        ];

        for (const item of items) {
            current.internals.addItemToLocalState(item);
            await storeItemInSessionStore(store, "session-1", item);
        }

        const before = current.builder.build();
        const response: ModelResponse = { TurnID: "compact", Response: textResponse("Summary") };
        response.Response.Output?.push({
            Type: "tool_call",
            Data: { CallID: "summary-call", Name: "unknown", Arguments: "" },
        });
        current.internals.callModel = true;
        const statuses = await current.internals.handleModelResponse(response);
        // compaction response changed ordinary scheduling
        expect(statuses).toHaveLength(0);
        expect(current.internals.callModel).toBe(true);
        current.internals.addItemToLocalState({ Kind: "model_response", Data: response });
        // compaction changed pending work
        expect(current.internals.currentTurnType).toBe("compaction");
        expect(current.internals.deliveredInputs).toBe(0);
        expect(current.internals.pendingInputs()).toBe(3);
        expect(current.internals.toolCallStates()).toHaveLength(1);
        expect(current.internals.operationStates().size).toBe(2);
        // `localfile.New(directory)` reopens the same files; the twin reuses the store, whose reads are copies.
        const reopened = store;
        const page = await reopened.items("session-1", 0, 100);
        const last = page.Items[page.Items.length - 1];
        // compaction response was not persisted
        expect(last.Kind).toBe("model_response");
        expect(last.Data).toEqual(response);
        const { store: replayStore, registry: replayRegistry } = independentToolCalls(0);
        const replayed = newTestCoordinator(replayStore, replayRegistry);
        replayed.deps.sessions = reopened;
        await replayed.internals.loadHistory();
        // wantState := current.state; wantState.callModel = false
        expect(stateSnapshot(replayed.internals)).toEqual({ ...stateSnapshot(current.internals), callModel: false });

        for (const builder of [current.builder, replayed.builder]) {
            const built = builder.build();
            // compaction changed active context
            expect(built.Request).toEqual(before.Request);
        }
    });
});

// Twins of harness/coordinator/unavailable_tool_test.go.

import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { newBuilder } from "./contextbuilder";
import type { ToolCall } from "./llm";
import type { Operation } from "./operation";
import {
    BASH_NAME,
    emptyFakeStore,
    newRegistry,
    newTestCoordinator,
    newValueSpec,
    SubmittingTranslator,
    storedItem,
    usage,
    withPreamble,
} from "./testing/driver";
import { type CallStatus, MapRegistry, type Translator } from "./tool";

describe("unavailable_tool_test.go", () => {
    test("TestCoordinatorRejectsRestoreWhenRecordedCallRequiresUnavailableTool", async () => {
        const cases: Array<{ name: string; status: CallStatus; operations?: Operation[] }> = [
            { name: "successful translation", status: { Error: "" } },
            { name: "pending operation", status: { Error: "", WaitingFor: ["operation-1"] } },
            {
                name: "completed operation",
                status: { Error: "", WaitingFor: ["operation-1"] },
                operations: [{ ID: "operation-1", Type: "", Version: 0, Status: "completed" }],
            },
            { name: "error with operation", status: { Error: "error", WaitingFor: ["operation-1"] } },
            {
                name: "error with recorded operation but no waiting IDs",
                status: { Error: "error" },
                operations: [{ ID: "operation-1", Type: "", Version: 0, Status: "completed" }],
            },
        ];

        for (const testCase of cases) {
            const store = emptyFakeStore();
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
                                { Type: "tool_call", Data: { CallID: "call-1", Name: BASH_NAME, Arguments: "{}" } },
                            ],
                        },
                    },
                }),
                storedItem(3, {
                    Kind: "tool_call_status",
                    Data: {
                        TurnID: "turn-1",
                        CallID: "call-1",
                        Status: testCase.status,
                        ...(testCase.operations ? { Operations: testCase.operations } : {}),
                    },
                }),
            ];
            // Go: `tool.NewRegistry(tool.StaticTranslators{Bash: ...})` with no enabled names, so
            // Bash is configured but does not resolve. The disabled registry is built directly,
            // which is the same thing `newRegistry({ Bash: translator })` with no enabled names gives.
            const disabled = new MapRegistry(new Map<string, Translator>());
            const current = newTestCoordinator(store, disabled, { builder: newBuilder() });
            let error: unknown;

            try {
                await current.internals.restore();
            } catch (caught) {
                error = caught;
            }

            // restore error
            expect({ name: testCase.name, error: String(error) }).toEqual({
                name: testCase.name,
                error: expect.stringContaining(`tool "Bash" required by recorded call "call-1" is not available`),
            });
        }
    });

    test("TestCoordinatorSchedulesAvailableCallAlongsideUnavailableCall", async () => {
        const spec = newValueSpec(`{"value":1}`);
        const translator = new SubmittingTranslator();
        translator.specs = [spec];
        const store = emptyFakeStore();
        const current = newTestCoordinator(store, newRegistry({ Bash: translator }, BASH_NAME), {
            builder: newBuilder(),
        });
        const valid: ToolCall = { CallID: "valid", Name: BASH_NAME, Arguments: "{}" };
        const statuses = await current.internals.handleModelResponse({
            TurnID: "turn-1",
            Response: {
                ID: "",
                Stop: "complete",
                Usage: usage(),
                Output: [
                    { Type: "tool_call", Data: { CallID: "unknown", Name: "unknown-tool", Arguments: "" } },
                    { Type: "tool_call", Data: valid },
                ],
            },
        });
        expect(statuses).toHaveLength(2);
        expect(store.appendedStatuses).toHaveLength(2);
        expect(translator.calls).toEqual([valid]);

        for (const status of store.appendedStatuses) {
            switch (status.CallID) {
                case "unknown":
                    // unavailable call status
                    expect(status.Status.Error).toBe(`tool "unknown-tool" is not available`);
                    expect(status.Operations ?? []).toHaveLength(0);
                    expect(status.Status.WaitingFor ?? []).toHaveLength(0);
                    break;
                case "valid":
                    // available call status
                    expect(status.Status.Error).toBe("");
                    expect(status.Operations ?? []).toHaveLength(1);
                    expect(status.Status.WaitingFor ?? []).toHaveLength(1);
                    break;
                default:
                    throw new Error(`unexpected call status = ${SafeJSON.stringify(status, { strict: true })}`);
            }
        }
    });

    test("TestCoordinatorRestoresUnavailableToolCall", async () => {
        for (const recorded of [false, true]) {
            const call: ToolCall = { CallID: "call-1", Name: "unknown-tool", Arguments: "{}" };
            const wantError = `tool "unknown-tool" is not available`;
            const store = emptyFakeStore();
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
                            Output: [{ Type: "tool_call", Data: call }],
                        },
                    },
                }),
            ];

            if (recorded) {
                store.items.push(
                    storedItem(3, {
                        Kind: "tool_call_status",
                        Data: { TurnID: "turn-1", CallID: call.CallID, Status: { Error: wantError } },
                    })
                );
            }

            const builder = newBuilder();
            const current = newTestCoordinator(store, new MapRegistry(new Map<string, Translator>()), { builder });
            await current.internals.restore();
            const wantNewStatuses = recorded ? 0 : 1;
            // scheduled statuses
            expect(await current.internals.scheduleToolCalls()).toHaveLength(wantNewStatuses);
            const built = builder.build();
            const want = withPreamble(
                { Type: "tool_call", Data: call },
                { Type: "tool_result", Data: { CallID: call.CallID, Output: [{ Kind: "text", Value: wantError }] } }
            );
            // restored input
            expect(built.Request.Input).toEqual(want);
            // rejected call was rescheduled
            expect(await current.internals.scheduleToolCalls()).toHaveLength(0);
            // rejected call remained pending
            expect(current.internals.toolCallStates()).toHaveLength(0);
            expect(store.appendedStatuses).toHaveLength(wantNewStatuses);
        }
    });
});

// Twins of harness/coordinator/fork_test.go.
//
// Fork mapping: the port's `Store` has no `fork()`. `LocalStore.fork` (testing/rest-helpers.ts)
// builds the child history the way Go's `forkStoredState` does: the parent's items up to the
// `previousTurnID` boundary, inherited tool-call statuses stripped of their operation snapshots,
// then a `{Kind: "fork", Data: {ParentID, PreviousTurnID}}` item and a reset of owned state.

import { describe, expect, test } from "bun:test";
import { SLURP_IDLE_MS } from "./coordinator";
import {
    BASH_NAME,
    externalEvent,
    newRegistry,
    newStopTestRun,
    newValueSpec,
    SubmittingTranslator,
    stopInput,
    TestTranslator,
    textResponse,
    usage,
    VIEW_IMAGE_NAME,
} from "./testing/driver";
import { persistTestRun, statusAt } from "./testing/rest-helpers";

describe("fork_test.go", () => {
    test("TestCoordinatorForkStopsWhenChildIsIdle", async () => {
        for (const parentStage of ["unscheduled", "running", "completed", "compaction", "compaction response"]) {
            for (const childTool of [false, true]) {
                const name = `parent=${parentStage}/child-tool=${childTool}`;
                const parent = newStopTestRun(1);

                if (parentStage === "unscheduled") {
                    parent.store.items = parent.store.items.slice(0, 2);
                }

                const store = await persistTestRun(parent);
                let previousTurn = "turn-1";

                if (parentStage === "completed") {
                    const status = statusAt(parent.store.items, 2);
                    const completed = { ...(status.Operations ?? [])[0], Status: "completed" as const };
                    await store.saveOperation("session-1", completed);
                    await store.appendToolCallStatus("session-1", { ...status, Operations: [completed] });
                    previousTurn = "parent-final";
                    await store.appendTurn("session-1", {
                        ID: previousTurn,
                        PreviousTurnID: "turn-1",
                        Type: "regular",
                    });
                    await store.appendModelResponse("session-1", {
                        TurnID: previousTurn,
                        Response: textResponse("Parent done."),
                    });
                }

                const compaction = parentStage === "compaction" || parentStage === "compaction response";

                if (compaction) {
                    previousTurn = "compact";
                    await store.appendTurn("session-1", {
                        ID: previousTurn,
                        PreviousTurnID: "turn-1",
                        Type: "compaction",
                    });

                    if (parentStage === "compaction response") {
                        await store.appendModelResponse("session-1", {
                            TurnID: previousTurn,
                            Response: textResponse("Summary"),
                        });
                    }
                }

                await store.fork("child", "session-1", previousTurn);
                const restored = await store.resume("child");
                const child = newStopTestRun(0);
                child.deps.sessionID = "child";
                child.deps.sessions = store;
                child.deps.restored = restored;
                const translator = new SubmittingTranslator();
                translator.specs = [newValueSpec(`{"value":1}`)];
                child.deps.tools = newRegistry(
                    { Bash: translator, ViewImage: new TestTranslator() },
                    BASH_NAME,
                    VIEW_IMAGE_NAME
                );
                await child.start();
                child.assertRunning();
                // inherited tool call became active child work
                expect({ name, adds: child.operations.adds.length }).toEqual({ name, adds: 0 });
                expect({ name, calls: child.internals().toolCallStates().length }).toEqual({ name, calls: 0 });
                // fork lost the parent turn boundary
                expect({ name, turn: child.internals().currentTurnID }).toEqual({ name, turn: previousTurn });
                // fork changed the parent turn kind or started inherited work
                expect({ name, compaction: child.internals().currentTurnType === "compaction" }).toEqual({
                    name,
                    compaction,
                });
                expect(child.internals().pendingInputs()).toBe(0);
                expect(child.calls).toHaveLength(0);
                await child.input(externalEvent("child-user", "hello"), stopInput("child-stop", "when_idle"));
                // child turn did not establish its own type
                expect(child.internals().currentTurnType).toBe("regular");
                const inheritedCall = child.calls[0].request.Input.some(
                    (item) => item.Type === "tool_call" && item.Data.CallID === "call-0"
                );
                // fork lost its parent context
                expect({ name, inheritedCall }).toEqual({ name, inheritedCall: true });

                if (childTool) {
                    // Go's zero `llm.Response{Output: ...}`; the TS type needs a Stop reason and usage.
                    await child.respond(0, {
                        ID: "",
                        Stop: "complete",
                        Usage: usage(),
                        Output: [
                            { Type: "tool_call", Data: { CallID: "child-call", Name: BASH_NAME, Arguments: "{}" } },
                        ],
                    });
                    child.assertRunning();
                    // child tool call was not tracked
                    expect(child.operations.adds).toHaveLength(1);
                    expect(child.internals().toolCallStates()).toHaveLength(1);
                    const completed = { ...child.operations.adds[0], Status: "completed" as const };
                    child.operations.updateQueue.push(completed);
                    await child.sleep(2 * SLURP_IDLE_MS);
                    child.assertRunning();
                    await child.respond(1, textResponse("Child tool done."));
                } else {
                    await child.respond(0, textResponse("Child done."));
                }

                child.assertStopped();
            }
        }
    });
});

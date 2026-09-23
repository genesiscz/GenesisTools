// Twins of harness/coordinator/stop_test.go.

import { describe, expect, test } from "bun:test";
import { AbortedError, drainTasks } from "./clock";
import { SLURP_IDLE_MS } from "./coordinator";
import type { Status } from "./operation";
import {
    assertCompletedResults,
    assertStopResult,
    externalEvent,
    FakeAdapter,
    heartbeatInput,
    newStopTestRun,
    stopInput,
    storedItem,
    textResponse,
    usage,
    VIEW_IMAGE_NAME,
} from "./testing/driver";

const TERMINALS: Status[] = ["completed", "failed", "canceled"];

describe("stop_test.go", () => {
    test("TestCoordinatorRemainsAvailableUntilStop", async () => {
        const run = newStopTestRun(0);
        await run.start();
        run.assertRunning();

        for (let index = 0; index < 2; index++) {
            await run.input(externalEvent(`input-${index}`, "hello"));
            await run.respond(index, textResponse("hello"));
            run.assertRunning();
        }

        await run.input(stopInput("stop", "when_idle"));
        run.assertStopped();
        expect(run.calls).toHaveLength(2);
    });

    test("TestCoordinatorWhenIdleDeliversPendingResults", async () => {
        for (const terminal of TERMINALS) {
            for (const duringRequest of [false, true]) {
                const run = newStopTestRun(1);
                await run.start();
                await run.input(externalEvent("progress", "check progress"));
                await run.input(stopInput("stop", "when_idle"));
                expect(run.calls).toHaveLength(1);
                expect(run.calls[0].signal.aborted).toBe(false);

                if (duringRequest) {
                    await run.update(0, terminal);
                }

                await run.respond(0, textResponse("The check is still running."));
                run.assertRunning();

                if (!duringRequest) {
                    expect(run.calls).toHaveLength(1);
                    await run.update(0, terminal);
                }

                expect(run.calls).toHaveLength(2);
                assertStopResult(run.calls[1].request, "call-0", terminal);
                await run.respond(1, textResponse("All results received."));
                run.assertStopped();
                expect(run.operations.cancels).toHaveLength(0);
            }
        }
    });

    test("TestCoordinatorStopsAfterCancellationIsRecorded", async () => {
        const run = newStopTestRun(2);
        await run.start();
        await run.input(externalEvent("progress", "check progress"));
        await run.input(stopInput("stop", "hard"));
        expect(run.calls[0].signal.aborted).toBe(true);
        expect(run.operations.cancels).toHaveLength(2);
        expect(run.operations.cancelReasons.every((reason) => reason === "user requested stop")).toBe(true);
        run.assertRunning();
        await run.update(0, "canceled");
        run.assertRunning();
        await run.update(1, "completed");
        expect(run.store.savedOperations).toHaveLength(2);
        expect(run.store.appendedStatuses).toHaveLength(2);
        expect(run.calls).toHaveLength(1);
        run.assertStopped();
        expect(run.operations.cancels).toHaveLength(2);
    });

    test("TestCoordinatorCancelsCompactionWithoutRecordingAResponse", async () => {
        for (const mode of ["hard", "steer"] as const) {
            const run = newStopTestRun(0);
            run.ignoreCancellation();
            await run.start();
            await run.input(externalEvent("first", "hello"));
            run.internals().setCurrentTurnType("compaction");

            if (mode === "steer") {
                await run.input(externalEvent("second", "change course"));
            } else {
                await run.input(stopInput("stop", mode));
            }

            const wantType = mode === "hard" ? "compaction" : "regular";
            expect(run.calls[0].signal.aborted).toBe(true);
            expect(run.internals().currentTurnType).toBe(wantType);
            await run.respond(0, textResponse("Late summary"));
            expect(run.store.appendedResponses).toHaveLength(0);
            expect(run.internals().deliveredInputs).toBe(0);

            if (mode !== "hard") {
                expect(run.calls).toHaveLength(2);
                expect(run.internals().modelActive).toBe(true);
                await run.input(stopInput("idle", "when_idle"));
                await run.respond(1, textResponse("Done"));
            }

            run.assertStopped();
        }
    });

    test("TestCoordinatorHardStopOverridesWhenIdle", async () => {
        const run = newStopTestRun(1);
        await run.start();
        await run.input(externalEvent("first", "hello"));
        await run.input(stopInput("idle", "when_idle"));
        expect(run.calls[0].signal.aborted).toBe(false);
        await run.input(stopInput("hard", "hard"));
        await run.input(
            stopInput("idle-again", "when_idle"),
            stopInput("hard-again", "hard"),
            heartbeatInput("heartbeat"),
            externalEvent("late", "more work")
        );
        run.assertRunning();
        expect(run.internals().stopMode).toBe("hard");
        expect(run.operations.cancels).toHaveLength(1);
        expect(run.calls).toHaveLength(1);
        expect(run.calls[0].signal.aborted).toBe(true);
        await run.update(0, "canceled");
        run.assertStopped();
        expect(run.operations.cancels).toHaveLength(1);
        expect(run.calls).toHaveLength(1);
    });

    test("TestCoordinatorHardStopDiscardsLateModelResponse", async () => {
        const run = newStopTestRun(1);
        run.ignoreCancellation();
        await run.start();
        await run.input(externalEvent("first", "hello"));
        await run.input(stopInput("stop", "hard"));
        run.assertRunning();
        await run.respond(0, {
            ID: "",
            Stop: "complete",
            Usage: usage(),
            Output: [{ Type: "tool_call", Data: { CallID: "late", Name: VIEW_IMAGE_NAME, Arguments: "{}" } }],
        });
        expect(run.store.appendedResponses).toHaveLength(0);
        expect(run.store.appendedStatuses).toHaveLength(0);
        expect(run.calls).toHaveLength(1);
        await run.update(0, "canceled");
        run.assertStopped();
    });

    test("TestCoordinatorStopPropagatesErrors", async () => {
        for (const failure of ["input", "cancel", "operation", "tool-result"]) {
            const run = newStopTestRun(2);
            const want = new Error("test failure");

            switch (failure) {
                case "input":
                    run.store.appendInputErr = want;
                    break;
                case "cancel":
                    run.operations.cancelErr = want;
                    break;
                case "operation":
                    run.store.saveOperationErr = want;
                    break;
                default:
                    run.store.appendStatusErr = want;
            }

            await run.start();
            await run.input(stopInput("stop", "hard"));

            if (failure === "operation" || failure === "tool-result") {
                await run.update(0, "canceled");
            }

            expect(run.done.settled).toBe(true);
            expect(String((run.done.error as Error).message)).toContain("test failure");

            if (failure === "cancel") {
                expect(run.operations.cancels).toHaveLength(2);
            }
        }
    });

    test("TestCoordinatorCancellationWhileCollectingUpdates", async () => {
        for (const source of ["inbox", "operation updates"]) {
            const run = newStopTestRun(1);
            const controller = new AbortController();
            await run.start(controller.signal);

            if (source === "inbox") {
                await run.inputs.submit(externalEvent("input", "hello"));
            } else {
                run.operations.updateQueue.push({ ...run.store.resume.Operations[0], Status: "completed" });
            }

            await drainTasks();
            const want = new Error("caller disconnected");
            controller.abort(want);
            await drainTasks();
            expect(run.done.settled).toBe(true);
            expect((run.done.error as Error).message.startsWith("slurp inbox:")).toBe(true);
            expect((run.done.error as Error).cause).toBe(want);
            const [wantInputs, wantUpdates] = source === "inbox" ? [1, 0] : [0, 1];
            expect(run.store.appendedInputs).toHaveLength(wantInputs);
            expect(run.store.savedOperations).toHaveLength(wantUpdates);
            expect(run.calls).toHaveLength(0);
        }
    });

    test("TestCoordinatorDrainsInboxAndOperationsBeforeCallingModel", async () => {
        const run = newStopTestRun(1);
        await run.start();
        await run.inputs.submit(externalEvent("input", "check completed work"));
        run.operations.updateQueue.push({ ...run.store.resume.Operations[0], Status: "completed" });
        await drainTasks();
        await run.clock.advance(2 * SLURP_IDLE_MS);
        await drainTasks();

        expect(run.calls).toHaveLength(1);
        assertCompletedResults(run.calls[0].request, 1);
        const foundInput = run.calls[0].request.Input.some(
            (item) => item.Type === "message" && item.Data.Text === "check completed work"
        );
        expect(foundInput).toBe(true);
        expect(run.store.appendedInputs).toHaveLength(1);
        expect(run.store.savedOperations).toHaveLength(1);
        run.cancel();
    });

    test("TestCoordinatorCancellationTakesPrecedenceOverModelError", async () => {
        const run = newStopTestRun(0);
        const controller = new AbortController();
        let fail: ((error: Error) => void) | null = null;
        run.deps.llm = new FakeAdapter(
            (_request, signal) =>
                new Promise((_resolve, reject) => {
                    fail = (error) => {
                        // Cancel after the loop receives the model error, before it handles it.
                        controller.abort(new AbortedError("canceled"));
                        reject(error);
                    };
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                })
        );
        await run.start(controller.signal);
        await run.input(externalEvent("input", "hello"));
        expect(run.internals().modelActive).toBe(true);
        expect(fail).not.toBeNull();
        (fail as unknown as (error: Error) => void)(new Error("model failed"));
        await drainTasks();
        expect(run.done.settled).toBe(true);
        expect(run.done.error).toBeInstanceOf(AbortedError);
        expect(run.store.appendedResponses).toHaveLength(0);
    });

    test("TestCoordinatorStopControlsDoNotRepeatOnResume", async () => {
        for (const mode of ["hard", "when_idle"] as const) {
            const run = newStopTestRun(0);
            run.store.items.push(storedItem(3, { Kind: "input", Data: stopInput("old-stop", mode) }));
            await run.start();
            run.assertRunning();
            await run.input(externalEvent("new", "continue"));
            await run.respond(0, textResponse("Continuing."));
            run.assertRunning();
            await run.input(stopInput("new-stop", "hard"));
            run.assertStopped();
        }
    });

    test("TestCoordinatorWhenIdleDeliversRestoredResults", async () => {
        for (const stage of ["completed", "request-started", "response-recorded"]) {
            const run = newStopTestRun(1);
            const item = run.store.items[2];

            if (item.Kind !== "tool_call_status") {
                throw new Error("fixture shape changed");
            }

            item.Data = { ...item.Data, Operations: [{ ...(item.Data.Operations ?? [])[0], Status: "completed" }] };
            run.store.resume.Operations = [];

            if (stage !== "completed") {
                run.store.items.push(
                    storedItem(4, {
                        Kind: "turn",
                        Data: { ID: "delivered", PreviousTurnID: "turn-1", Type: "regular" },
                    })
                );
            }

            if (stage === "response-recorded") {
                run.store.items.push(
                    storedItem(5, {
                        Kind: "model_response",
                        Data: { TurnID: "delivered", Response: textResponse("Done.") },
                    })
                );
            }

            await run.start();
            await run.input(stopInput("stop", "when_idle"));

            if (stage !== "response-recorded") {
                expect(run.calls).toHaveLength(1);
                assertStopResult(run.calls[0].request, "call-0", "completed");
                await run.respond(0, textResponse("Done."));
            } else {
                expect(run.calls).toHaveLength(0);
            }

            run.assertStopped();
        }
    });
});

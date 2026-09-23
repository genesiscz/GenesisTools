// Twins of harness/coordinator/heartbeat_test.go.
//
// Mapping: `advanceHeartbeatTime(d)` is `run.sleep(ms)`; `time.Nanosecond` is `NS` (1e-6 ms);
// `assertHeartbeatCount` / `latestHeartbeatReason` read `run.heartbeats()`, which decodes the
// store's `appendedInputs` (the Go `recordedInputs`).

import { describe, expect, test } from "bun:test";
import { newCoordinator, SLURP_IDLE_MS } from "./coordinator";
import { Inbox } from "./inbox";
import type { Item } from "./sessionstore";
import {
    assertCompletedResults,
    assertStopResult,
    countHeartbeatMessages,
    externalEvent,
    heartbeatInput,
    newHeartbeatTestRun,
    type StopTestRun,
    stopInput,
    storedItem,
    textResponse,
} from "./testing/driver";
import { awaitDone, errorIs } from "./testing/hss-helpers";

const NS = 1e-6;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function latestHeartbeatReason(run: StopTestRun): string {
    const latest = run.heartbeats().at(-1);

    if (!latest) {
        throw new Error("no recorded heartbeat");
    }

    return latest.reason;
}

describe("heartbeat_test.go", () => {
    test("TestCoordinatorHeartbeatsWhileWaitingForTools", async () => {
        const run = newHeartbeatTestRun(2);
        run.deps.toolHeartbeatIntervalMs = MINUTE;
        await run.start();
        await run.sleep(30 * SECOND);
        await run.update(0, "awaiting");
        await run.sleep(30 * SECOND - 2 * SLURP_IDLE_MS - NS);
        expect(run.requestCount()).toBe(0);
        await run.sleep(NS + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(1);
        const wantReason =
            "Heartbeat: waited 60 seconds for tool calls.\nRunning: " +
            `[{"CallID":"call-0","Name":"ViewImage","Arguments":"{}"},{"CallID":"call-1","Name":"ViewImage","Arguments":"{}"}]`;
        expect(latestHeartbeatReason(run)).toBe(wantReason);
        expect(run.requestCount()).toBe(1);
        expect(countHeartbeatMessages(run.calls[0].request)).toBe(1);
        await run.sleep(3 * MINUTE);
        run.assertHeartbeatCount(1);
        // heartbeat interrupted or overlapped an active model request
        expect(run.requestCount()).toBe(1);
        expect(run.calls[0].signal.aborted).toBe(false);
        await run.respond(0, textResponse("Still waiting."));
        await run.sleep(MINUTE - NS);
        run.assertHeartbeatCount(1);
        await run.sleep(NS + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(2);
        // next heartbeat did not append exactly one check-in
        expect(run.requestCount()).toBe(2);
        expect(countHeartbeatMessages(run.calls[1].request)).toBe(2);
        await run.update(0, "completed");
        await run.update(1, "completed");
        // tool completion interrupted a heartbeat response
        expect(run.requestCount()).toBe(2);
        expect(run.calls[1].signal.aborted).toBe(false);
        await run.respond(1, textResponse("Waiting for results."));
        // completed results were not delivered after the model response
        expect(run.requestCount()).toBe(3);
        assertCompletedResults(run.calls[2].request, 2);
        await run.respond(2, textResponse("Done."));
        await run.sleep(3 * MINUTE);
        run.assertHeartbeatCount(2);
        // heartbeats continued without pending calls or canceled operations
        expect(run.requestCount()).toBe(3);
        expect(run.operations.cancels).toHaveLength(0);
        await run.input(stopInput("stop", "when_idle"));
        run.assertStopped();
    });

    test("TestCoordinatorHeartbeatDisabledOrIdle", async () => {
        for (const { pending, interval } of [
            { name: "disabled", pending: 1, interval: 0 },
            { name: "idle", pending: 0, interval: SECOND },
        ]) {
            const run = newHeartbeatTestRun(pending);
            run.deps.toolHeartbeatIntervalMs = interval;
            await run.start();
            await run.sleep(HOUR);
            run.assertHeartbeatCount(0);
            // unexpected model request
            expect(run.requestCount()).toBe(0);
            run.cancel();
        }
    });

    test("TestCoordinatorHeartbeatYieldsToSteeringAndResults", async () => {
        const run = newHeartbeatTestRun(2);
        run.deps.toolHeartbeatIntervalMs = MINUTE;
        await run.start();
        await run.sleep(30 * SECOND);
        await run.input(externalEvent("steering", "check progress"));
        await run.sleep(MINUTE);
        run.assertHeartbeatCount(0);
        await run.respond(0, textResponse("Waiting."));
        await run.sleep(30 * SECOND);
        await run.update(0, "completed");
        // result waited for a heartbeat
        expect(run.requestCount()).toBe(2);
        await run.respond(1, textResponse("One remains."));
        await run.sleep(MINUTE - NS);
        run.assertHeartbeatCount(0);
        await run.sleep(NS + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(1);
        const wantReason =
            "Heartbeat: waited 60 seconds for tool calls.\nRunning: " +
            `[{"CallID":"call-1","Name":"ViewImage","Arguments":"{}"}]`;
        // want only the remaining call
        expect(latestHeartbeatReason(run)).toBe(wantReason);
        run.cancel();
    });

    test("TestHeartbeatDiscardsPreviousDeadline", async () => {
        const run = newHeartbeatTestRun(1);
        run.deps.toolHeartbeatIntervalMs = MINUTE;
        await run.start();
        const oldDeadline = run.clock.now() + MINUTE;
        await run.sleep(20 * SECOND);
        await run.input(externalEvent("steering", "continue"));
        await run.respond(0, textResponse("Waiting."));
        const newDeadline = run.clock.now() + MINUTE;
        await run.sleep(oldDeadline - run.clock.now() + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(0);
        // discarded deadline started a turn
        expect(run.requestCount()).toBe(1);
        await run.sleep(newDeadline - run.clock.now() + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(1);
        run.cancel();
    });

    test("TestHeartbeatIntervalShorterThanInboxBatch", async () => {
        const run = newHeartbeatTestRun(1);
        run.deps.toolHeartbeatIntervalMs = NS;
        await run.start();

        for (let index = 0; index < 3; index++) {
            await run.sleep(NS + 2 * SLURP_IDLE_MS);
            run.assertHeartbeatCount(index + 1);
            // heartbeat prevented inbox delivery
            expect(run.requestCount()).toBe(index + 1);
            await run.sleep(SECOND);
            run.assertHeartbeatCount(index + 1);
            await run.respond(index, textResponse("Waiting."));
        }

        await run.input(stopInput("stop", "hard"));
        await run.update(0, "canceled");
        run.assertStopped();
    });

    test("TestQueuedHeartbeatPreservesActiveModelResponse", async () => {
        const run = newHeartbeatTestRun(1);
        await run.start();
        await run.input(externalEvent("steering", "check progress"));
        await run.input(heartbeatInput("queued-heartbeat"));
        // queued heartbeat interrupted the model
        expect(run.requestCount()).toBe(1);
        expect(run.calls[0].signal.aborted).toBe(false);
        await run.respond(0, textResponse("Working."));
        // queued heartbeat was not delivered in the next turn
        expect(run.requestCount()).toBe(2);
        expect(countHeartbeatMessages(run.calls[1].request)).toBe(1);
        await run.respond(1, textResponse("Waiting."));
        await run.sleep(HOUR);
        // queued heartbeat was delivered twice
        expect(run.requestCount()).toBe(2);
        run.cancel();
    });

    test("TestHeartbeatWaitsForAllOperationsOfCall", async () => {
        const run = newHeartbeatTestRun(2);
        const responseItem = run.store.items[1];
        const statusItem = run.store.items[2];

        if (responseItem.Kind !== "model_response" || statusItem.Kind !== "tool_call_status") {
            throw new Error("fixture shape changed");
        }

        responseItem.Data = {
            ...responseItem.Data,
            Response: { ...responseItem.Data.Response, Output: responseItem.Data.Response.Output?.slice(0, 1) },
        };
        const operations = run.store.resume.Operations;
        statusItem.Data = {
            ...statusItem.Data,
            Operations: operations,
            Status: { ...statusItem.Data.Status, WaitingFor: [operations[0].ID, operations[1].ID] },
        };
        run.store.items = run.store.items.slice(0, 3);
        run.deps.toolHeartbeatIntervalMs = MINUTE;
        await run.start();
        const deadline = run.clock.now() + MINUTE;
        await run.sleep(30 * SECOND);
        await run.update(0, "completed");
        // partial completion started a turn
        expect(run.requestCount()).toBe(0);
        await run.sleep(deadline - run.clock.now() + 2 * SLURP_IDLE_MS);
        run.assertHeartbeatCount(1);
        await run.respond(0, textResponse("Waiting."));
        await run.update(1, "completed");
        // last operation did not complete the call
        expect(run.requestCount()).toBe(2);
        assertStopResult(run.calls[1].request, "call-0", "completed,completed");
        await run.respond(1, textResponse("Done."));
        await run.sleep(MINUTE);
        run.assertHeartbeatCount(1);
        run.cancel();
    });

    test("TestCoordinatorHeartbeatStopsDuringCancellation", async () => {
        const run = newHeartbeatTestRun(1);
        run.deps.toolHeartbeatIntervalMs = MINUTE;
        await run.start();
        await run.sleep(30 * SECOND);
        await run.input(stopInput("stop", "hard"));
        await run.sleep(3 * MINUTE);
        run.assertHeartbeatCount(0);
        // heartbeat ran during cancellation
        expect(run.requestCount()).toBe(0);
        await run.update(0, "canceled");
        run.assertStopped();
    });

    test("TestHeartbeatControlPreservesWhenIdleStop", async () => {
        const run = newHeartbeatTestRun(1);
        await run.start();
        await run.input(stopInput("stop", "when_idle"), heartbeatInput("heartbeat"));
        // heartbeat changed the stop or failed to wake the model
        expect(run.internals().stopMode).toBe("when_idle");
        expect(run.requestCount()).toBe(1);
        await run.respond(0, textResponse("Waiting."));
        await run.update(0, "completed");
        await run.respond(1, textResponse("Done."));
        run.assertStopped();
    });

    // Was a PORT-DEFECT (notes-hss.md #1): the loop re-read `deps.inbox.outputQueue()` on every
    // iteration, while Go captures the select channels once before the loop. Fixed in coordinator.ts.
    test("TestCoordinatorHeartbeatPropagatesSubmissionFailure", async () => {
        const run = newHeartbeatTestRun(1);
        run.deps.toolHeartbeatIntervalMs = SECOND;

        const controller = new AbortController();
        const stoppedInbox = new Inbox(controller.signal);
        const want = new Error("heartbeat inbox stopped");
        controller.abort(want);
        run.store.onSaveOperation = () => {
            // Swap on the coordinator goroutine while retaining its live inbox output.
            run.deps.inbox = stoppedInbox;
        };
        await run.start();
        await run.update(0, "awaiting");

        await run.sleep(SECOND);
        // Run did not return the heartbeat submission error
        expect(run.done.settled).toBe(true);
        expect(errorIs(run.done.error, want)).toBe(true);
        run.assertHeartbeatCount(0);
        // model ran after heartbeat submission failed
        expect(run.requestCount()).toBe(0);
    });

    test("TestCoordinatorHeartbeatRequiresPersistence", async () => {
        const run = newHeartbeatTestRun(1);
        run.deps.toolHeartbeatIntervalMs = SECOND;
        const want = new Error("heartbeat storage failed");
        run.store.appendInputErr = want;
        await run.start();
        await run.sleep(SECOND);
        expect(errorIs(await awaitDone(run), want)).toBe(true);
        // model ran before heartbeat was persisted
        expect(run.requestCount()).toBe(0);
    });

    test("TestCoordinatorReplaysHeartbeat", async () => {
        for (const stage of ["input", "turn", "response"]) {
            const run = newHeartbeatTestRun(1);
            const added: Item[] = [storedItem(4, { Kind: "input", Data: heartbeatInput("heartbeat-1") })];

            if (stage !== "input") {
                added.push(
                    storedItem(5, { Kind: "turn", Data: { ID: "heartbeat-turn", PreviousTurnID: "", Type: "regular" } })
                );
            }

            if (stage === "response") {
                added.push(
                    storedItem(6, {
                        Kind: "model_response",
                        Data: { TurnID: "heartbeat-turn", Response: textResponse("Waiting.") },
                    })
                );
            }

            run.store.items.push(...added);
            await run.start();
            const built = run.builder.build();
            // heartbeat was not replayed exactly once
            expect(countHeartbeatMessages(built.Request)).toBe(1);

            if (stage === "response") {
                // delivered heartbeat woke the model again on resume
                expect(run.requestCount()).toBe(0);
            } else {
                // undelivered heartbeat was not resumed
                expect(run.requestCount()).toBe(1);
                expect(run.calls[0].request).toEqual(built.Request);
            }

            run.assertHeartbeatCount(0);
            run.cancel();
        }
    });

    test("TestCoordinatorRejectsNegativeHeartbeatInterval", async () => {
        const run = newHeartbeatTestRun(0);
        run.deps.toolHeartbeatIntervalMs = -SECOND;
        const outcome = await newCoordinator(run.deps)
            .run(new AbortController().signal)
            .then(
                () => null,
                (error: unknown) => error
            );
        // Run error = %v, want invalid interval
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome instanceof Error ? outcome.message : outcome)).toContain("heartbeat interval");
    });
});

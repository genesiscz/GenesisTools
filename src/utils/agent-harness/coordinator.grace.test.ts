// Twins of harness/coordinator/grace_test.go.

import { describe, expect, test } from "bun:test";
import { TOOL_CALL_RUNNING_PAYLOAD } from "./contextbuilder";
import { TOOL_CALL_RUN_GRACE_MS } from "./coordinator";
import type { Status } from "./operation";
import {
    assertStopResult,
    externalEvent,
    heartbeatInput,
    newToolGraceTestRun,
    stopInput,
    textResponse,
    toolGraceResponse,
    updateToolGraceCall,
    VIEW_IMAGE_NAME,
} from "./testing/driver";

const TERMINALS: Status[] = ["completed", "failed", "canceled"];

describe("grace_test.go", () => {
    test("TestCoordinatorToolGraceBatchesCompletionsUntilAllCallsFinish", async () => {
        for (const terminal of TERMINALS) {
            const run = newToolGraceTestRun();
            await run.start();
            await run.input(externalEvent("input", "run both tools"));
            await run.respond(0, toolGraceResponse("A", "B"));
            const deadline = run.clock.now() + 1000;
            await updateToolGraceCall(run, "A", terminal);
            expect(run.requestCount()).toBe(1);
            expect(run.store.appendedStatuses).toHaveLength(3);
            await run.sleep(100);
            await updateToolGraceCall(run, "B", terminal);
            expect(run.requestCount()).toBe(2);
            expect(run.clock.now()).toBeLessThan(deadline);
            assertStopResult(run.calls[1].request, "A", terminal);
            assertStopResult(run.calls[1].request, "B", terminal);
            await run.respond(1, textResponse("Done."));
            await run.sleep(deadline - run.clock.now() + 1000);
            expect(run.requestCount()).toBe(2);
            run.cancel();
        }
    });

    test("TestCoordinatorToolGraceWaitsOnlyForLatestTurn", async () => {
        for (const endGrace of ["steering", "expiry"]) {
            const run = newToolGraceTestRun();
            await run.start();
            await run.input(externalEvent("input", "run three tools"));
            await run.respond(0, toolGraceResponse("A", "B", "C"));
            await updateToolGraceCall(run, "A", "completed");

            if (endGrace === "steering") {
                await run.input(externalEvent("steering", "run two more tools"));
            } else {
                await run.sleep(TOOL_CALL_RUN_GRACE_MS);
            }

            await run.respond(1, toolGraceResponse("D", "E"));
            const deadline = run.clock.now() + TOOL_CALL_RUN_GRACE_MS;
            await updateToolGraceCall(run, "B", "completed");
            expect(run.requestCount()).toBe(2);
            await updateToolGraceCall(run, "D", "completed");
            expect(run.requestCount()).toBe(2);
            await updateToolGraceCall(run, "E", "completed");
            expect(run.requestCount()).toBe(3);
            expect(run.clock.now()).toBeLessThan(deadline);

            for (const callID of ["A", "B", "D", "E"]) {
                assertStopResult(run.calls[2].request, callID, "completed");
            }

            assertStopResult(run.calls[2].request, "C", TOOL_CALL_RUNNING_PAYLOAD);
            await run.respond(2, textResponse("Waiting for C."));
            await updateToolGraceCall(run, "C", "completed");
            expect(run.requestCount()).toBe(4);
            assertStopResult(run.calls[3].request, "C", "completed");
            run.cancel();
        }
    });

    test("TestCoordinatorToolGraceDeadlineDoesNotResetOnCompletion", async () => {
        const run = newToolGraceTestRun();
        await run.start();
        await run.input(externalEvent("input", "run three tools"));
        await run.respond(0, toolGraceResponse("A", "B", "C"));
        const deadline = run.clock.now() + 1000;
        await run.sleep(100);
        await updateToolGraceCall(run, "A", "completed");
        await run.sleep(400);
        await updateToolGraceCall(run, "B", "completed");
        await run.sleep(deadline - run.clock.now() - 1);
        expect(run.requestCount()).toBe(1);
        await run.sleep(1);
        expect(run.requestCount()).toBe(2);
        assertStopResult(run.calls[1].request, "A", "completed");
        assertStopResult(run.calls[1].request, "B", "completed");
        assertStopResult(run.calls[1].request, "C", TOOL_CALL_RUNNING_PAYLOAD);
        await run.sleep(1000);
        expect(run.requestCount()).toBe(2);
        expect(run.calls[1].signal.aborted).toBe(false);
        run.cancel();
    });

    test("TestCoordinatorToolGraceExpiryWithoutResultsDoesNotStartTurn", async () => {
        const run = newToolGraceTestRun();
        await run.start();
        await run.input(externalEvent("input", "run both tools"));
        await run.respond(0, toolGraceResponse("A", "B"));
        await run.sleep(1000);
        expect(run.requestCount()).toBe(1);
        await updateToolGraceCall(run, "A", "completed");
        expect(run.requestCount()).toBe(2);
        assertStopResult(run.calls[1].request, "A", "completed");
        assertStopResult(run.calls[1].request, "B", TOOL_CALL_RUNNING_PAYLOAD);
        run.cancel();
    });

    test("TestCoordinatorInboxEndsToolGracePeriod", async () => {
        for (const kind of ["external", "heartbeat"]) {
            const run = newToolGraceTestRun();
            await run.start();
            await run.input(externalEvent("input", "run both tools"));
            await run.respond(0, toolGraceResponse("A", "B"));
            await updateToolGraceCall(run, "A", "completed");
            await run.input(
                kind === "heartbeat" ? heartbeatInput("heartbeat") : externalEvent("steering", "check progress")
            );
            expect(run.requestCount()).toBe(2);
            assertStopResult(run.calls[1].request, "A", "completed");
            assertStopResult(run.calls[1].request, "B", TOOL_CALL_RUNNING_PAYLOAD);
            await run.respond(1, textResponse("Waiting."));
            await updateToolGraceCall(run, "B", "completed");
            expect(run.requestCount()).toBe(3);
            assertStopResult(run.calls[2].request, "B", "completed");
            run.cancel();
        }
    });

    test("TestCoordinatorToolGraceDiscardsPreviousDeadline", async () => {
        const run = newToolGraceTestRun();
        await run.start();
        await run.input(externalEvent("input", "run both tools"));
        await run.respond(0, toolGraceResponse("A", "B"));
        const oldDeadline = run.clock.now() + 1000;
        await run.sleep(250);
        await run.input(externalEvent("steering", "run another tool"));
        await run.respond(1, toolGraceResponse("C"));
        const newDeadline = run.clock.now() + 1000;
        await updateToolGraceCall(run, "A", "completed");
        await run.sleep(oldDeadline - run.clock.now() + 1);
        expect(run.requestCount()).toBe(2);
        await run.sleep(newDeadline - run.clock.now());
        expect(run.requestCount()).toBe(3);
        assertStopResult(run.calls[2].request, "A", "completed");
        assertStopResult(run.calls[2].request, "B", TOOL_CALL_RUNNING_PAYLOAD);
        assertStopResult(run.calls[2].request, "C", TOOL_CALL_RUNNING_PAYLOAD);
        run.cancel();
    });

    test("TestCoordinatorImmediateToolStatusBypassesGrace", async () => {
        for (const name of [VIEW_IMAGE_NAME, "unavailable"]) {
            const run = newToolGraceTestRun();
            await run.start();
            await run.input(externalEvent("input", "run both tools"));
            const response = toolGraceResponse("A");
            response.Output?.push({ Type: "tool_call", Data: { CallID: "immediate", Name: name, Arguments: "{}" } });
            await run.respond(0, response);
            expect(run.requestCount()).toBe(2);
            expect(run.operations.adds).toHaveLength(1);
            assertStopResult(
                run.calls[1].request,
                "immediate",
                name === "unavailable" ? 'tool "unavailable" is not available' : ""
            );
            assertStopResult(run.calls[1].request, "A", TOOL_CALL_RUNNING_PAYLOAD);
            run.cancel();
        }
    });

    test("TestCoordinatorStopDuringToolGracePeriod", async () => {
        for (const mode of ["hard", "when_idle"] as const) {
            const run = newToolGraceTestRun();
            await run.start();
            await run.input(externalEvent("input", "run tool"));
            await run.respond(0, toolGraceResponse("A"));
            await run.input(stopInput("stop", mode));
            let terminal: Status = "canceled";

            if (mode === "when_idle") {
                terminal = "completed";
                expect(run.operations.cancels).toHaveLength(0);
            } else {
                expect(run.operations.cancels).toHaveLength(1);
            }

            expect(run.requestCount()).toBe(1);
            await updateToolGraceCall(run, "A", terminal);

            if (mode !== "hard") {
                expect(run.requestCount()).toBe(2);
                assertStopResult(run.calls[1].request, "A", terminal);
                await run.respond(1, textResponse("Done."));
            } else {
                expect(run.requestCount()).toBe(1);
            }

            run.assertStopped();
        }
    });
});

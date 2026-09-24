// Twins of harness/coordinator/settings_test.go.

import { describe, expect, test } from "bun:test";
import type { ControlMode } from "./inbox";
import type { Turn } from "./sessionstore";
import {
    assertStopResult,
    externalEvent,
    newHeartbeatTestRun,
    newStopTestRun,
    newToolGraceTestRun,
    stopInput,
    textResponse,
    toolGraceResponse,
    updateToolGraceCall,
} from "./testing/driver";
import { errorIs, persistTestRun, prefixIDs, settingsInput } from "./testing/rest-helpers";

describe("settings_test.go", () => {
    test("TestCoordinatorSettingsDoNotWakeOrInterruptModel", async () => {
        const run = newStopTestRun(0);
        await run.start();
        await run.input(settingsInput("initial", { ReasoningEffort: "low" }));
        // settings woke an idle model
        expect(run.requestCount()).toBe(0);
        expect(run.internals().pendingInputs()).toBe(0);
        run.assertRunning();
        await run.input(externalEvent("prompt", "hello"));
        // next turn did not use settings
        expect(run.requestCount()).toBe(1);
        expect(run.calls[0].request.Model.ReasoningEffort).toBe("low");
        await run.input(settingsInput("next", { ReasoningEffort: "high" }));
        // settings interrupted or altered the active request
        expect(run.requestCount()).toBe(1);
        expect(run.calls[0].signal.aborted).toBe(false);
        expect(run.calls[0].request.Model.ReasoningEffort).toBe("low");
        await run.respond(0, textResponse("Hello."));
        // settings caused an extra turn after the response
        expect(run.requestCount()).toBe(1);
        expect(run.internals().pendingInputs()).toBe(0);
        await run.input(externalEvent("follow-up", "continue"));
        // following turn did not use updated settings
        expect(run.requestCount()).toBe(2);
        expect(run.calls[1].request.Model.ReasoningEffort).toBe("high");
        await run.respond(1, textResponse("Done."));
        await run.input(stopInput("stop", "when_idle"));
        run.assertStopped();
    });

    test("TestCoordinatorSettingsPreserveToolGraceAndApplyToContinuation", async () => {
        const run = newToolGraceTestRun();
        await run.start();
        await run.input(externalEvent("prompt", "run both tools"));
        await run.respond(0, toolGraceResponse("A", "B"));
        await updateToolGraceCall(run, "A", "completed");
        // Go compares the grace channel by identity (`run.current.state.grace != grace`); the
        // generation counter says whether it is still the same armed timer.
        const grace = run.internals().graceGeneration;
        expect(run.internals().graceActive).toBe(true);
        await run.input(settingsInput("settings", { ReasoningEffort: "max" }));
        // settings disturbed pending operations or ended their grace period
        expect(run.requestCount()).toBe(1);
        expect(run.internals().graceToolCallKeys()).toHaveLength(1);
        expect(run.internals().graceActive).toBe(true);
        expect(run.internals().graceGeneration).toBe(grace);
        expect(run.operations.cancels).toHaveLength(0);
        await updateToolGraceCall(run, "B", "completed");
        // automatic continuation did not use updated settings
        expect(run.requestCount()).toBe(2);
        expect(run.calls[1].request.Model.ReasoningEffort).toBe("max");
        assertStopResult(run.calls[1].request, "A", "completed");
        assertStopResult(run.calls[1].request, "B", "completed");
        run.cancel();
    });

    test("TestCoordinatorSettingsFollowInboxOrderAndDeduplicate", async () => {
        // Go's heartbeatTestRun.recordedInputs is every input the store appended: FakeStore.appendedInputs.
        const run = newHeartbeatTestRun(0);
        await run.start();
        const first = settingsInput("first", { ReasoningEffort: "low" });
        const last = settingsInput("last", { ReasoningEffort: "high" });
        await run.input(first, last, first);
        expect(run.store.appendedInputs).toEqual([first, last]);
        await run.input(externalEvent("prompt", "hello"));
        // duplicate rolled back the latest settings
        expect(run.calls[0].request.Model.ReasoningEffort).toBe("high");
        run.cancel();
    });

    test("TestCoordinatorSettingsPreservePendingStop", async () => {
        for (const mode of ["hard", "when_idle"] satisfies ControlMode[]) {
            const run = newStopTestRun(1);
            await run.start();
            await run.input(stopInput("stop", mode), settingsInput("settings", { ReasoningEffort: "high" }));
            run.assertRunning();
            // settings changed the pending stop or started a turn
            expect(run.internals().stopMode).toBe(mode);
            expect(run.requestCount()).toBe(0);

            if (mode === "hard") {
                // settings prevented operation cancellation
                expect(run.operations.cancels).toHaveLength(1);
                await run.update(0, "canceled");
                // hard stop started a final turn
                expect(run.requestCount()).toBe(0);
            } else {
                // settings canceled pending work
                expect(run.operations.cancels).toHaveLength(0);
                await run.update(0, "completed");
                // final turn did not use updated settings
                expect(run.requestCount()).toBe(1);
                expect(run.calls[0].request.Model.ReasoningEffort).toBe("high");
                await run.respond(0, textResponse("Done."));
            }

            run.assertStopped();
        }
    });

    test("TestCoordinatorSettingsRequirePersistence", async () => {
        const run = newStopTestRun(0);
        const want = new Error("settings storage failed");
        run.store.appendInputErr = want;
        await run.start();
        await run.input(settingsInput("settings", { ReasoningEffort: "high" }));
        expect(run.done.settled).toBe(true);
        expect(errorIs(run.done.error, want)).toBe(true);
        // model ran after settings persistence failed
        expect(run.requestCount()).toBe(0);
    });

    test("TestCoordinatorSettingsReplayOnResumeAndFork", async () => {
        for (const mode of ["resume", "fork"]) {
            const parent = newStopTestRun(0);
            const store = await persistTestRun(parent);

            for (const input of [
                settingsInput("first", { ReasoningEffort: "low" }),
                settingsInput("last", { ReasoningEffort: "high" }),
            ]) {
                await store.appendInput("session-1", input);
            }

            const turn: Turn = { ID: "parent-turn", PreviousTurnID: "turn-1", Type: "regular" };
            await store.appendTurn("session-1", turn);
            await store.appendModelResponse("session-1", { TurnID: turn.ID, Response: textResponse("Done.") });
            let id = "session-1";

            if (mode === "fork") {
                id = "child";
                await store.fork(id, "session-1", turn.ID);
            }

            const restored = await store.resume(id);
            const run = newStopTestRun(0);
            prefixIDs(run, "resumed");
            run.deps.sessionID = id;
            run.deps.sessions = store;
            run.deps.restored = restored;
            run.deps.contextBuilder.setModel({ ID: "model", ReasoningEffort: "medium" });
            await run.start();
            // replayed settings started a turn
            expect(run.requestCount()).toBe(0);
            await run.input(externalEvent("prompt", "continue"));
            // latest recorded settings did not override initial configuration
            expect(run.calls[0].request.Model.ID).toBe("model");
            expect(run.calls[0].request.Model.ReasoningEffort).toBe("high");
            run.cancel();
        }
    });
});

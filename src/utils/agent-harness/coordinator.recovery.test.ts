// Twins of harness/coordinator/recovery_test.go.

import { describe, expect, test } from "bun:test";
import { type Status, UnsupportedOperationError } from "./operation";
import type { Turn } from "./sessionstore";
import {
    assertStopResult,
    externalEvent,
    newStopTestRun,
    stopInput,
    storedItem,
    textResponse,
    withPreamble,
} from "./testing/driver";
import {
    errorChainHas,
    LocalStore,
    newLocalManagerStandIn,
    persistTestRun,
    prefixIDs,
    responseAt,
    restoreTestRun,
    statusAt,
    turnAt,
} from "./testing/rest-helpers";
import { MapRegistry, type Translator } from "./tool";

/** `tool.NewRegistry(tool.StaticTranslators{})`: nothing enabled, nothing resolves. */
function emptyRegistry(): MapRegistry {
    return new MapRegistry(new Map<string, Translator>());
}

const TERMINALS: Status[] = ["completed", "failed", "canceled"];

describe("recovery_test.go", () => {
    test("TestCoordinatorResumesUnavailableTool", async () => {
        for (const stage of ["untranslated", "rejected", "accepted"]) {
            const run = newStopTestRun(1);
            const wantError = `tool "ViewImage" is not available`;

            switch (stage) {
                case "untranslated":
                    run.store.items = run.store.items.slice(0, 2);
                    break;
                case "rejected": {
                    const status = statusAt(run.store.items, 2);
                    const { Operations: _dropped, ...rest } = status;
                    run.store.items[2] = {
                        ...run.store.items[2],
                        Kind: "tool_call_status",
                        Data: { ...rest, Status: { Error: wantError } },
                    };
                    break;
                }
            }

            const store = await persistTestRun(run);
            const before = await store.items("session-1", 0, 100);
            await restoreTestRun(run, store);
            run.deps.tools = emptyRegistry();
            await run.start();

            if (stage !== "accepted") {
                await run.input(stopInput("stop", "when_idle"));
                // unavailable tool did not produce one corrective request without dispatch
                expect(run.calls).toHaveLength(1);
                expect(run.operations.adds).toHaveLength(0);
                assertStopResult(run.calls[0].request, "call-0", wantError);
                await run.respond(0, textResponse("Corrected."));
                run.assertStopped();

                const resumed = newStopTestRun(0);
                prefixIDs(resumed, "resumed");
                resumed.deps.tools = emptyRegistry();
                await restoreTestRun(resumed, store);
                await resumed.start();
                await resumed.input(stopInput("stop-again", "when_idle"));
                resumed.assertStopped();
                // settled validation error started work on resume
                expect(resumed.calls).toHaveLength(0);
                expect(resumed.operations.adds).toHaveLength(0);
                continue;
            }

            // Run did not abort
            expect(run.done.settled).toBe(true);
            expect(String(run.done.error)).toContain(
                `tool "ViewImage" required by recorded call "call-0" is not available`
            );
            // unresolvable tool started work
            expect(run.calls).toHaveLength(0);
            expect(run.operations.adds).toHaveLength(0);
            const after = await store.items("session-1", 0, 100);
            // failed resume changed persisted history
            expect(after).toEqual(before);
        }
    });

    test("TestCoordinatorResumesUnansweredInput", async () => {
        for (const stage of ["input", "turn", "response", "compaction", "compaction response"]) {
            const run = newStopTestRun(0);
            run.store.items = [storedItem(1, { Kind: "input", Data: externalEvent("user", "hello") })];

            if (stage !== "input") {
                const turn: Turn = { ID: "first", PreviousTurnID: "", Type: "regular" };

                if (stage === "compaction" || stage === "compaction response") {
                    turn.Type = "compaction";
                }

                run.store.items.push(storedItem(2, { Kind: "turn", Data: turn }));
            }

            if (stage === "response" || stage === "compaction response") {
                run.store.items.push(
                    storedItem(3, {
                        Kind: "model_response",
                        Data: { TurnID: "first", Response: textResponse("Hello.") },
                    })
                );
            }

            await run.start();
            await run.input(stopInput("stop", "when_idle"));

            if (stage === "response") {
                // answered input caused another request
                expect(run.calls).toHaveLength(0);
            } else {
                // requests = N, want resumed input delivery
                expect(run.calls).toHaveLength(1);
                // resume did not start ordinary delivery of pending input
                expect(run.internals().currentTurnType).toBe("regular");
                expect(run.internals().currentTurnID).not.toBe("first");
                expect(run.internals().pendingInputs()).toBe(1);
                const want = withPreamble({ Type: "message", Data: { Role: "user", Text: "hello" } });
                // resume changed pending input context
                expect(run.calls[0].request.Input).toEqual(want);
                await run.respond(0, textResponse("Hello."));
            }

            // ordinary response did not deliver pending input
            expect(run.internals().pendingInputs()).toBe(0);
            run.assertStopped();
        }
    });

    test("TestCoordinatorStopRejectsUnsupportedOperation", async () => {
        for (const mode of ["hard", "when_idle"] as const) {
            const run = newStopTestRun(1);
            // PORT-NA stand-in: `operation.NewLocalOperationManager` is not ported. It rejects the
            // fixture's "shell" operation with ErrUnsupported, which is all this test exercises.
            run.deps.operations = newLocalManagerStandIn();
            await run.inputs.submit(stopInput("stop", mode));
            await run.start();
            // Run is waiting for an unsupported operation
            expect(run.done.settled).toBe(true);
            expect(errorChainHas(run.done.error, (error) => error instanceof UnsupportedOperationError)).toBe(true);
            // unsupported operation changed state or started a model request
            expect(run.store.savedOperations).toHaveLength(0);
            expect(run.calls).toHaveLength(0);
        }
    });

    test("TestCoordinatorResumesSavedTerminalOperation", async () => {
        for (const terminal of TERMINALS) {
            const run = newStopTestRun(1);
            const store = new LocalStore();
            await store.create("session-1");
            await store.appendTurn("session-1", turnAt(run.store.items, 0));
            await store.appendModelResponse("session-1", responseAt(run.store.items, 1));
            await store.appendToolCallStatus("session-1", statusAt(run.store.items, 2));
            const completed = { ...run.store.resume.Operations[0], Status: terminal };
            await store.saveOperation("session-1", completed);
            // `localfile.New(directory)` again: the twin reuses the store (see rest-helpers.ts).
            const restored = await store.resume("session-1");
            run.deps.sessions = store;
            run.deps.restored = restored;
            await run.start();
            await run.input(stopInput("stop", "when_idle"));
            // saved terminal operation was dispatched again
            expect(run.operations.adds).toHaveLength(0);
            // requests = N, want restored result delivery
            expect(run.calls).toHaveLength(1);
            assertStopResult(run.calls[0].request, "call-0", terminal);
            await run.respond(0, textResponse("Done."));
            run.assertStopped();

            const resumed = newStopTestRun(0);
            prefixIDs(resumed, "resumed");
            const again = await store.resume("session-1");
            // settled operations retained for resume
            expect(again.Operations).toHaveLength(0);
            resumed.deps.sessions = store;
            resumed.deps.restored = again;
            await resumed.start();
            await resumed.input(stopInput("stop-again", "when_idle"));
            // delivered terminal result caused work on the next resume
            expect(resumed.calls).toHaveLength(0);
            expect(resumed.operations.adds).toHaveLength(0);
            resumed.assertStopped();
        }
    });
});

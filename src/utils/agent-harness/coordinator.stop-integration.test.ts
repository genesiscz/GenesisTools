// Twins of harness/coordinator/stop_integration_test.go.
//
// Both Go tests run the real `operation.NewLocalOperationManager`. The primitive runtime is not
// ported (UPSTREAM.md), so the twins run against `testing/local-operation-manager.ts`, which
// honours the manager contract for the two operation types these tests use: a shell process in
// its own process group whose state reports `ProcessGroupID`, and a value operation that
// completes at once. What the twins verify is the coordinator: the hard stop cancels the running
// operation, the canceled status is persisted, no model request follows, and a stop queued at the
// tool-status commit boundary still settles the operation.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { newBuilder } from "./contextbuilder";
import { newCoordinator } from "./coordinator";
import { Inbox } from "./inbox";
import type { Operation } from "./operation";
import { BEFORE_FIRST } from "./sessionstore";
import {
    externalEvent,
    FakeAdapter,
    independentToolCalls,
    newToolGraceTestRun,
    stopInput,
    textResponse,
    toolGraceResponse,
} from "./testing/driver";
import { LocalOperationManager, newShellSpec, type ShellState } from "./testing/local-operation-manager";
import { persistTestRun, restoreTestRun } from "./testing/rest-helpers";

const managers: LocalOperationManager[] = [];

function newLocalManager(): LocalOperationManager {
    const manager = new LocalOperationManager();
    managers.push(manager);
    return manager;
}

afterEach(() => {
    for (const manager of managers.splice(0)) {
        manager.dispose();
    }
});

describe("stop_integration_test.go", () => {
    test("TestCoordinatorStopCancelsShellProcess", async () => {
        const { store, registry } = independentToolCalls(1);
        const spec = newShellSpec(
            { Shell: "/bin/sh", Command: "exec sleep 30", Directory: "" },
            mkdtempSync(join(tmpdir(), "harness-shell-")),
            64
        );
        const value = store.resume.Operations[0];
        value.Status = "ready";
        value.State = spec.State;
        value.Type = spec.Type;
        value.Version = spec.Version;
        value.MaxOutputLength = spec.MaxOutputLength;
        const inboxController = new AbortController();
        const inputs = new Inbox(inboxController.signal);
        const stop = stopInput("stop", "hard");
        let processGroupID = 0;
        store.onSaveOperation = (update: Operation) => {
            const state = SafeJSON.parse(update.State ?? "{}", { strict: true }) as ShellState;

            if (processGroupID === 0 && (state.ProcessGroupID ?? 0) > 1) {
                processGroupID = state.ProcessGroupID ?? 0;
                void inputs.submit(stop);
            }
        };
        const runController = new AbortController();
        const timeout = setTimeout(() => runController.abort(new Error("test timeout")), 10_000);
        const adapter = new FakeAdapter(async () => textResponse("Stopped."));
        const current = newCoordinator({
            toolHeartbeatIntervalMs: 0,
            sessionID: "session-1",
            inbox: inputs,
            restored: store.resume,
            sessions: store.asStore(),
            contextBuilder: newBuilder(),
            llm: adapter,
            tools: registry,
            operations: newLocalManager(),
        });

        try {
            await current.run(runController.signal);
        } finally {
            clearTimeout(timeout);
            inboxController.abort();
        }

        expect(processGroupID).toBeGreaterThan(1);
        // Go: `syscall.Kill(-processGroupID, 0)` must fail with ESRCH: the whole group is gone. The
        // shell exec's the command, so the group leader is the only member and stands for the group.
        expect(isProcessAlive(processGroupID)).toBe(false);
        const last = store.appendedStatuses[store.appendedStatuses.length - 1];
        expect(last?.Operations?.[0]?.Status).toBe("canceled");
        expect(adapter.requests).toHaveLength(0);
    });

    test("TestCoordinatorStopAfterToolCommitSettlesOperation", async () => {
        const run = newToolGraceTestRun();
        const store = await persistTestRun(run);
        await restoreTestRun(run, store);
        run.deps.operations = newLocalManager();
        let stopQueued = false;
        const observer = store.addObserver((_id, item) => {
            if (item.Kind !== "tool_call_status" || stopQueued) {
                return;
            }

            if ((item.Data.Operations?.length ?? 0) === 0) {
                return;
            }

            stopQueued = true;
            void run.inputs.submit(stopInput("stop", "hard"));
        });

        try {
            await run.start();
            await run.input(externalEvent("input", "run tool"));
            await run.respond(0, toolGraceResponse("A"));
            run.assertStopped();
        } finally {
            store.removeObserver(observer);
        }

        expect(stopQueued && run.calls.length === 1).toBe(true);
        const page = await store.items("session-1", BEFORE_FIRST, 100);
        const last = page.Items[page.Items.length - 1];
        expect(last?.Kind).toBe("tool_call_status");

        if (last?.Kind !== "tool_call_status") {
            throw new Error("unreachable");
        }

        expect(last.Data.CallID).toBe("A");
        expect(last.Data.Operations).toHaveLength(1);
        expect(last.Data.Operations?.[0]?.Status).toBe("completed");
        const restored = await store.resume("session-1");
        expect(restored.Operations).toHaveLength(0);
    });
});

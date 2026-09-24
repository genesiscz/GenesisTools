import { describe, expect, test } from "bun:test";
import type { Operation, Status } from "../operation";
import { MemoryStore, type Page } from "../sessionstore";

// Not a Go twin: `MemoryStore` has no upstream counterpart, so this file sits outside the twin
// directory the reconcile script scans. It pins `resume` to the `ResumeState` contract that
// localfile keeps and `LocalStore` (rest-helpers) mirrors.

function operation(id: string, status: Status): Operation {
    return { ID: id, Type: "shell", Version: 1, Status: status };
}

describe("MemoryStore.items", () => {
    test("pages the history by sequence, including a cursor past the end and a negative one", async () => {
        const store = new MemoryStore("session-1", () => "2026-09-24T10:00:00.000Z");

        for (const id of ["a", "b", "c", "d", "e"]) {
            await store.appendInput("session-1", { ID: id, Kind: "external" });
        }

        const ids = (page: Page) => page.Items.map((item) => (item.Kind === "input" ? item.Data.ID : item.Kind));
        const first = await store.items("session-1", 0, 2);
        const second = await store.items("session-1", first.NextAfter, 2);
        const last = await store.items("session-1", second.NextAfter, 2);
        const beyond = await store.items("session-1", 9, 2);
        const before = await store.items("session-1", -3, 2);

        expect([ids(first), first.NextAfter, first.More]).toEqual([["a", "b"], 2, true]);
        expect([ids(second), second.NextAfter, second.More]).toEqual([["c", "d"], 4, true]);
        expect([ids(last), last.NextAfter, last.More]).toEqual([["e"], 5, false]);
        expect([ids(beyond), beyond.NextAfter, beyond.More]).toEqual([[], 9, false]);
        expect([ids(before), before.More]).toEqual([["a", "b"], true]);
        await expect(store.items("session-1", 0, 0)).rejects.toThrow("invalid page size");
    });
});

describe("MemoryStore.resume", () => {
    test("keeps the ResumeState contract: external inputs, unsettled operations, creation time", async () => {
        const clock = ["2026-09-24T10:00:00.000Z", "2026-09-24T10:00:01.000Z", "2026-09-24T10:00:02.000Z"];
        let tick = 0;
        const store = new MemoryStore("session-1", () => clock[Math.min(tick++, clock.length - 1)]);

        await store.appendInput("session-1", { ID: "in-1", Kind: "external" });
        await store.appendInput("session-1", { ID: "in-2", Kind: "control" });
        await store.appendInput("session-1", { ID: "in-3", Kind: "crash" });
        await store.appendToolCallStatus("session-1", {
            TurnID: "turn-1",
            CallID: "call-1",
            Status: { Error: "" },
            Operations: [operation("running", "ready"), operation("settled", "ready"), operation("missed", "ready")],
        });
        await store.appendToolCallStatus("session-1", {
            TurnID: "turn-1",
            CallID: "call-1",
            Status: { Error: "" },
            Operations: [operation("settled", "completed")],
        });
        await store.saveOperation("session-1", operation("settled", "completed"));
        // Finished after its last tool-call snapshot: history still shows it running.
        await store.saveOperation("session-1", operation("missed", "failed"));

        const restored = await store.resume("session-1");

        expect(restored.ExternalInputIDs).toEqual(["in-1"]);
        expect(restored.Operations.map((value) => [value.ID, value.Status])).toEqual([
            ["running", "ready"],
            ["missed", "failed"],
        ]);
        expect(restored.Snapshot.Session).toEqual({ ID: "session-1", CreatedAt: "2026-09-24T10:00:00.000Z" });
    });
});

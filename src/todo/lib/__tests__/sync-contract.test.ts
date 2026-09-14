import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import { MacReminders } from "@genesiscz/utils/macos/apple-reminders";
import { TodoStore } from "../store";
import { buildSyncReport, describeSyncOutcomes, hasSyncableTime, syncTodo } from "../sync";

/**
 * The observable contract of `--sync-to calendar`, against a real store on a temp
 * root with EventKit faked. No test in this file may reach the real calendar:
 * `MacCalendar.createEvent` is replaced before every call.
 */
let TEST_DIR: string;
let store: TodoStore;
let createEvent: Mock<typeof MacCalendar.createEvent>;
let createReminder: Mock<typeof MacReminders.createReminder>;

beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), "todo-sync-contract-"));
    store = TodoStore.forProject(TEST_DIR, { storageRoot: join(TEST_DIR, ".storage") });
    createEvent = spyOn(MacCalendar, "createEvent").mockResolvedValue("EVT-REAL-1");
    createReminder = spyOn(MacReminders, "createReminder").mockResolvedValue("REM-REAL-1");
});

afterEach(() => {
    createEvent.mockRestore();
    createReminder.mockRestore();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("calendar sync of an --at todo with no --reminder", () => {
    it("actually calls EventKit instead of reporting a silent no-op", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        const result = await syncTodo({ store, todo, target: "calendar" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(result.calendar?.ok).toBe(true);

        if (result.calendar?.ok) {
            expect(result.calendar.alreadySynced).toBeUndefined();
            expect(result.calendar.id).toBe("EVT-REAL-1");
        }
    });

    it("persists synced=calendar and the real event id on the todo", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "calendar" });
        const persisted = await store.get(todo.id);

        expect(persisted?.reminders).toHaveLength(1);
        expect(persisted?.reminders[0].synced).toBe("calendar");
        expect(persisted?.reminders[0].syncId).toBe("EVT-REAL-1");
    });

    it("creates the event at --at with an alert on the start", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "calendar" });

        const options = createEvent.mock.calls[0][0];
        expect(options.startDate.toISOString()).toBe("2026-09-15T10:00:00.000Z");
        expect(options.alerts).toEqual([0]);
    });

    it("reports created with the event id on stdout", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        const report = buildSyncReport(await syncTodo({ store, todo, target: "calendar" }), todo.id);

        expect(report.failed).toBe(false);
        expect(report.stderr).toEqual([]);
        expect(report.stdout).toEqual([`SYNC_OK calendar ${todo.id} created EVT-REAL-1`]);
    });

    it("routes the event to --calendar when one is named", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "calendar", calendarName: "Work" });

        expect(createEvent.mock.calls[0][0].calendarName).toBe("Work");
    });
});

describe("calendar sync failure modes", () => {
    it("fails loudly when the todo has neither --at nor a reminder", async () => {
        const todo = await store.add({ title: "no timing" });

        const result = await syncTodo({ store, todo, target: "calendar" });
        const report = buildSyncReport(result, todo.id);

        expect(createEvent).not.toHaveBeenCalled();
        expect(result.calendar?.ok).toBe(false);
        expect(report.failed).toBe(true);
        expect(report.stdout).toEqual([]);
        expect(report.stderr[0]).toContain(`SYNC_FAILED calendar ${todo.id}`);
        expect(report.stderr[0]).toContain("no event time");
    });

    it("records nothing on the todo when EventKit throws", async () => {
        createEvent.mockRejectedValue(new Error("darwinkit child died"));
        const todo = await store.add({ title: "doomed", at: "2026-09-15T10:00:00.000Z" });

        const report = buildSyncReport(await syncTodo({ store, todo, target: "calendar" }), todo.id);
        const persisted = await store.get(todo.id);

        expect(report.failed).toBe(true);
        expect(report.stderr[0]).toContain("darwinkit child died");
        expect(persisted?.reminders.every((r) => !r.synced)).toBe(true);
    });

    it("refuses to claim a sync when EventKit returns an empty identifier", async () => {
        createEvent.mockResolvedValue("");
        const todo = await store.add({ title: "empty id", at: "2026-09-15T10:00:00.000Z" });

        const result = await syncTodo({ store, todo, target: "calendar" });
        const persisted = await store.get(todo.id);

        expect(result.calendar?.ok).toBe(false);
        expect(persisted?.reminders.every((r) => !r.syncId)).toBe(true);
    });
});

describe("re-syncing an already synced todo", () => {
    it("does not report already-synced from a marker that carries no event id", async () => {
        const todo = await store.add({ title: "half-written", at: "2026-09-15T10:00:00.000Z" });
        await store.update(todo.id, { reminders: [{ at: "2026-09-15T10:00:00.000Z", synced: "calendar" }] });
        const stale = await store.get(todo.id);

        const result = await syncTodo({ store, todo: stale!, target: "calendar" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(result.calendar).toEqual({ ok: true, id: "EVT-REAL-1" });
    });

    it("reports already-synced with the original event id and calls EventKit once", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "calendar" });
        const again = await store.get(todo.id);
        const result = await syncTodo({ store, todo: again!, target: "calendar" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(describeSyncOutcomes(result, todo.id)).toEqual([
            `SYNC_OK calendar ${todo.id} already-synced EVT-REAL-1`,
        ]);
    });
});

describe("the timed-slot contract", () => {
    it("makes three wall-clock slots three todos, one event each", async () => {
        createEvent.mockResolvedValueOnce("EVT-12").mockResolvedValueOnce("EVT-14").mockResolvedValueOnce("EVT-16");

        const slots = ["2026-09-15T10:00:00.000Z", "2026-09-15T12:00:00.000Z", "2026-09-15T14:00:00.000Z"];
        const ids: string[] = [];

        for (const at of slots) {
            const todo = await store.add({ title: `slot ${at}`, at });
            await syncTodo({ store, todo, target: "calendar" });
            ids.push(todo.id);
        }

        expect(createEvent).toHaveBeenCalledTimes(3);
        expect(createEvent.mock.calls.map((c) => c[0].startDate.toISOString())).toEqual(slots);

        const persisted = await Promise.all(ids.map((id) => store.get(id)));
        expect(persisted.map((t) => t?.reminders[0].syncId)).toEqual(["EVT-12", "EVT-14", "EVT-16"]);
    });

    it("makes one todo with three reminders ONE event with three alerts", async () => {
        const todo = await store.add({
            title: "one meeting, three nudges",
            at: "2026-09-15T14:00:00.000Z",
            reminders: ["2026-09-15T13:00:00.000Z", "2026-09-15T13:45:00.000Z", "2026-09-15T14:00:00.000Z"],
        });

        await syncTodo({ store, todo, target: "calendar" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        const options = createEvent.mock.calls[0][0];
        expect(options.startDate.toISOString()).toBe("2026-09-15T14:00:00.000Z");
        expect(options.alerts).toEqual([60, 15, 0]);
    });
});
describe("--sync-to both", () => {
    it("keeps the calendar event id when the same todo also syncs to Reminders", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        const result = await syncTodo({ store, todo, target: "both" });
        const persisted = await store.get(todo.id);

        expect(result.calendar).toEqual({ ok: true, id: "EVT-REAL-1" });
        expect(result.reminders).toEqual({ ok: true, id: "REM-REAL-1" });
        expect(persisted?.reminders.find((r) => r.synced === "calendar")?.syncId).toBe("EVT-REAL-1");
        expect(persisted?.reminders.find((r) => r.synced === "reminders")?.syncId).toBe("REM-REAL-1");
    });

    it("does not create a second event when the todo is re-synced to calendar afterwards", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "both" });
        const again = await store.get(todo.id);
        const result = await syncTodo({ store, todo: again!, target: "calendar" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(result.calendar).toEqual({ ok: true, alreadySynced: true, id: "EVT-REAL-1" });
    });

    it("gives the Reminders item its own entry instead of an invented time", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "both" });
        const persisted = await store.get(todo.id);

        expect(persisted?.reminders).toHaveLength(2);
        expect(persisted?.reminders.map((r) => r.at)).toEqual(["2026-09-15T10:00:00.000Z", "2026-09-15T10:00:00.000Z"]);
    });

    it("claims the unsynced reminder rather than appending when one is free", async () => {
        const todo = await store.add({
            title: "two nudges",
            at: "2026-09-15T14:00:00.000Z",
            reminders: ["2026-09-15T13:00:00.000Z", "2026-09-15T13:45:00.000Z"],
        });

        await syncTodo({ store, todo, target: "reminders" });
        const persisted = await store.get(todo.id);

        expect(persisted?.reminders).toHaveLength(2);
        expect(persisted?.reminders[0].synced).toBe("reminders");
        expect(persisted?.reminders[0].syncId).toBe("REM-REAL-1");
    });

    it("keeps the Reminders id when the calendar sync runs SECOND", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "reminders" });
        const afterReminders = await store.get(todo.id);
        await syncTodo({ store, todo: afterReminders!, target: "calendar" });
        const persisted = await store.get(todo.id);

        expect(persisted?.reminders.find((r) => r.synced === "reminders")?.syncId).toBe("REM-REAL-1");
        expect(persisted?.reminders.find((r) => r.synced === "calendar")?.syncId).toBe("EVT-REAL-1");
    });

    it("does not create a second Reminders item when re-synced after the calendar", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "reminders" });
        const afterReminders = await store.get(todo.id);
        await syncTodo({ store, todo: afterReminders!, target: "calendar" });
        const afterCalendar = await store.get(todo.id);
        const result = await syncTodo({ store, todo: afterCalendar!, target: "reminders" });

        expect(createReminder).toHaveBeenCalledTimes(1);
        expect(result.reminders).toEqual({ ok: true, alreadySynced: true, id: "REM-REAL-1" });
    });

    it("is idempotent: a second `both` run creates nothing and grows nothing", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "both" });
        const first = await store.get(todo.id);
        const result = await syncTodo({ store, todo: first!, target: "both" });
        const second = await store.get(todo.id);

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(createReminder).toHaveBeenCalledTimes(1);
        expect(second?.reminders).toHaveLength(first?.reminders.length ?? 0);
        expect(result.calendar).toEqual({ ok: true, alreadySynced: true, id: "EVT-REAL-1" });
        expect(result.reminders).toEqual({ ok: true, alreadySynced: true, id: "REM-REAL-1" });
    });
});
describe("a writer racing the platform call", () => {
    it("keeps a reminder appended while EventKit was working, without claiming it", async () => {
        const todo = await store.add({
            title: "call slot",
            at: "2026-09-15T10:00:00.000Z",
            reminders: ["2026-09-15T09:00:00.000Z"],
        });

        createEvent.mockImplementation(async () => {
            await store.update(todo.id, {
                reminders: [...todo.reminders, { at: "2026-09-15T09:30:00.000Z", synced: null }],
            });

            return "EVT-REAL-1";
        });

        await syncTodo({ store, todo, target: "calendar" });
        const persisted = await store.get(todo.id);

        expect(persisted?.reminders).toHaveLength(2);
        expect(persisted?.reminders[0].syncId).toBe("EVT-REAL-1");
        expect(persisted?.reminders[1].at).toBe("2026-09-15T09:30:00.000Z");
        expect(persisted?.reminders[1].synced).toBeFalsy();
        expect(persisted?.reminders[1].syncId).toBeUndefined();
    });
});
describe("when the store write fails after the platform call", () => {
    it("reports a failure naming the created id instead of throwing", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });
        const updateWith = spyOn(store, "updateWith").mockRejectedValue(new Error("todo vanished"));

        try {
            const result = await syncTodo({ store, todo, target: "calendar" });
            const report = buildSyncReport(result, todo.id);

            expect(result.calendar?.ok).toBe(false);
            expect(report.failed).toBe(true);
            expect(report.stdout).toEqual([]);
            expect(report.stderr[0]).toContain("EVT-REAL-1");
            expect(report.stderr[0]).toContain("could not record it");
            expect(report.stderr[0]).toContain("todo vanished");
        } finally {
            updateWith.mockRestore();
        }
    });

    it("leaves an already-synced target alone, since it created nothing", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "calendar" });
        const synced = await store.get(todo.id);
        const updateWith = spyOn(store, "updateWith").mockRejectedValue(new Error("todo vanished"));

        try {
            const result = await syncTodo({ store, todo: synced!, target: "calendar" });

            expect(result.calendar).toEqual({ ok: true, alreadySynced: true, id: "EVT-REAL-1" });
        } finally {
            updateWith.mockRestore();
        }
    });
});

describe("the due date the Reminders item is created with", () => {
    it("comes from the todo's time under `--sync-to both`, not only on its own", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "both" });

        // The calendar branch runs first and stamps every entry, so a due date
        // read from "the first entry with no marker" found nothing and the item
        // was created undated. It must match the `reminders`-only run below.
        expect(createReminder.mock.calls[0][0].dueDate).toEqual(new Date("2026-09-15T10:00:00.000Z"));
    });

    it("is the same date a `--sync-to reminders` run would have used", async () => {
        const todo = await store.add({ title: "call slot", at: "2026-09-15T10:00:00.000Z" });

        await syncTodo({ store, todo, target: "reminders" });

        expect(createReminder.mock.calls[0][0].dueDate).toEqual(new Date("2026-09-15T10:00:00.000Z"));
    });

    it("takes the entry the item will own, not one the calendar already holds", async () => {
        const todo = await store.add({
            title: "two nudges",
            at: "2026-09-15T14:00:00.000Z",
            reminders: ["2026-09-15T13:00:00.000Z", "2026-09-15T13:45:00.000Z"],
        });

        await syncTodo({ store, todo, target: "both" });
        const persisted = await store.get(todo.id);
        const owned = persisted?.reminders.find((r) => r.synced === "reminders");

        expect(createReminder.mock.calls[0][0].dueDate).toEqual(new Date(owned!.at));
    });
});

describe("a todo with neither --at nor a reminder, synced to Reminders", () => {
    it("records the identifier even though there is no entry to claim", async () => {
        const todo = await store.add({ title: "plain todo" });

        const result = await syncTodo({ store, todo, target: "reminders" });
        const persisted = await store.get(todo.id);

        expect(result.reminders).toEqual({ ok: true, id: "REM-REAL-1" });
        expect(persisted?.reminders.find((r) => r.synced === "reminders")?.syncId).toBe("REM-REAL-1");
    });

    it("creates ONE item however often it is re-synced", async () => {
        const todo = await store.add({ title: "plain todo" });

        await syncTodo({ store, todo, target: "reminders" });
        const afterFirst = await store.get(todo.id);
        const second = await syncTodo({ store, todo: afterFirst!, target: "reminders" });

        // `tools todo sync <id> --sync-to reminders` exempts an untimed todo from
        // its "no event time" guard, so this path is reachable from the CLI and
        // used to create an unbounded number of duplicate items.
        expect(createReminder).toHaveBeenCalledTimes(1);
        expect(second.reminders).toEqual({ ok: true, alreadySynced: true, id: "REM-REAL-1" });
    });

    it("still refuses a calendar sync, since the anchor carries no time", async () => {
        const todo = await store.add({ title: "plain todo" });

        await syncTodo({ store, todo, target: "reminders" });
        const synced = await store.get(todo.id);
        const result = await syncTodo({ store, todo: synced!, target: "calendar" });

        expect(createEvent).not.toHaveBeenCalled();
        expect(result.calendar?.ok).toBe(false);
        expect(result.calendar).toMatchObject({ ok: false });
        expect((result.calendar as { ok: false; error: Error }).error.message).toContain("no event time");
    });
});

describe("which todos `sync --all` offers to a target", () => {
    it("skips a todo whose only entry is an untimed Reminders anchor", async () => {
        const todo = await store.add({ title: "plain todo" });

        await syncTodo({ store, todo, target: "reminders" });
        const anchored = await store.get(todo.id);

        // The anchor is an entry, so a `reminders.length > 0` filter would offer
        // this todo to `--all --to calendar`, which then fails the whole run on a
        // todo that was correctly skipped before it was ever synced.
        expect(anchored?.reminders).toHaveLength(1);
        expect(hasSyncableTime(anchored!)).toBe(false);
    });

    it("still offers a todo that has --at, and one that has a timed reminder", async () => {
        const timed = await store.add({ title: "timed", at: "2026-09-15T10:00:00.000Z" });
        const reminded = await store.add({ title: "reminded", reminders: ["2026-09-15T09:00:00.000Z"] });

        expect(hasSyncableTime(timed)).toBe(true);
        expect(hasSyncableTime(reminded)).toBe(true);
    });
});

describe("a todo that gained a time after it was already synced to Reminders", () => {
    it("creates the event, keeps both identifiers, and stays idempotent", async () => {
        const plain = await store.add({ title: "plain todo" });

        await syncTodo({ store, todo: plain, target: "reminders" });
        const timed = await store.update(plain.id, { at: "2026-09-15T10:00:00.000Z" });

        const result = await syncTodo({ store, todo: timed, target: "calendar" });
        const persisted = await store.get(plain.id);

        expect(result.calendar).toEqual({ ok: true, id: "EVT-REAL-1" });
        expect(persisted?.reminders.find((r) => r.synced === "reminders")?.syncId).toBe("REM-REAL-1");
        expect(persisted?.reminders.find((r) => r.synced === "calendar")?.syncId).toBe("EVT-REAL-1");

        const again = await syncTodo({ store, todo: persisted!, target: "both" });

        expect(createEvent).toHaveBeenCalledTimes(1);
        expect(createReminder).toHaveBeenCalledTimes(1);
        expect(again.calendar).toEqual({ ok: true, alreadySynced: true, id: "EVT-REAL-1" });
        expect(again.reminders).toEqual({ ok: true, alreadySynced: true, id: "REM-REAL-1" });
    });
});

import { describe, expect, it, spyOn } from "bun:test";
import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { DarwinkitCrashError, MacReminders } from "@app/utils/macos/apple-reminders";
import type { TodoStore } from "../store";
import { countSynced, describeSyncFailures, type SyncResult, syncSucceeded, syncTodo } from "../sync";
import type { Todo } from "../types";

function makeTodo(overrides?: Partial<Todo>): Todo {
    return {
        id: "TODO-001",
        title: "smoke test",
        description: undefined,
        priority: "medium",
        status: "todo",
        tags: [],
        links: [],
        reminders: [{ at: "2026-05-01T20:00:00.000Z", synced: null }],
        at: undefined,
        attachments: [],
        sessionId: undefined,
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
        ...overrides,
    } as Todo;
}

function makeFakeStore(): TodoStore {
    const updates: Array<{ id: string; patch: unknown }> = [];

    const fake = {
        update: async (id: string, patch: unknown) => {
            updates.push({ id, patch });
            return makeTodo({ id });
        },
        _updates: updates,
    };

    return fake as unknown as TodoStore;
}

describe("syncSucceeded / countSynced / describeSyncFailures", () => {
    it("reports success when all branches ok", () => {
        const r: SyncResult = { calendar: { ok: true }, reminders: { ok: true } };
        expect(syncSucceeded(r)).toBe(true);
        expect(countSynced(r)).toBe(2);
        expect(describeSyncFailures(r)).toEqual([]);
    });

    it("reports failure when one target failed", () => {
        const r: SyncResult = {
            calendar: { ok: true },
            reminders: { ok: false, error: new Error("boom") },
        };
        expect(syncSucceeded(r)).toBe(false);
        expect(countSynced(r)).toBe(1);
        expect(describeSyncFailures(r)).toEqual(["reminders: boom"]);
    });

    it("does not count alreadySynced as a fresh sync", () => {
        const r: SyncResult = { reminders: { ok: true, alreadySynced: true } };
        expect(syncSucceeded(r)).toBe(true);
        expect(countSynced(r)).toBe(0);
    });
});

describe("syncTodo (structured result)", () => {
    it("captures DarwinkitCrashError from reminders branch instead of throwing", async () => {
        const crash = new DarwinkitCrashError("reminders.save_item", 6, {
            reportPath: "/tmp/fake.ips",
        });

        const listsSpy = spyOn(MacReminders, "listLists").mockResolvedValue([
            { identifier: "list-1", title: "GenesisTools", color: "", source: "" } as unknown as never,
        ]);
        const createSpy = spyOn(MacReminders, "createReminder").mockRejectedValue(crash);

        try {
            const todo = makeTodo();
            const result = await syncTodo({
                store: makeFakeStore(),
                todo,
                target: "reminders",
            });

            expect(result.reminders).toBeDefined();
            expect(result.reminders?.ok).toBe(false);

            if (result.reminders && !result.reminders.ok) {
                expect(result.reminders.error).toBe(crash);
            }

            expect(syncSucceeded(result)).toBe(false);
            expect(countSynced(result)).toBe(0);
            expect(describeSyncFailures(result)[0]).toContain("darwinkit child died during reminders.save_item");
        } finally {
            listsSpy.mockRestore();
            createSpy.mockRestore();
        }
    });

    it("captures error from calendar branch independently of reminders branch", async () => {
        const calendarErr = new Error("calendar boom");
        const calendarSpy = spyOn(MacCalendar, "createEvent").mockRejectedValue(calendarErr);
        const listsSpy = spyOn(MacReminders, "listLists").mockResolvedValue([
            { identifier: "list-1", title: "GenesisTools", color: "", source: "" } as unknown as never,
        ]);
        const createSpy = spyOn(MacReminders, "createReminder").mockResolvedValue("REM-1");

        try {
            const todo = makeTodo({ at: "2026-05-01T21:00:00.000Z" });
            const result = await syncTodo({
                store: makeFakeStore(),
                todo,
                target: "both",
            });

            expect(result.calendar?.ok).toBe(false);
            expect(result.reminders?.ok).toBe(true);

            if (result.calendar && !result.calendar.ok) {
                expect(result.calendar.error).toBe(calendarErr);
            }

            expect(syncSucceeded(result)).toBe(false);
            expect(countSynced(result)).toBe(1);
            expect(describeSyncFailures(result)).toEqual(["calendar: calendar boom"]);
        } finally {
            calendarSpy.mockRestore();
            listsSpy.mockRestore();
            createSpy.mockRestore();
        }
    });

    it("returns alreadySynced=true when reminders branch was previously synced", async () => {
        const todo = makeTodo({
            reminders: [{ at: "2026-05-01T20:00:00.000Z", synced: "reminders", syncId: "REM-PREV" }],
        });

        const result = await syncTodo({ store: makeFakeStore(), todo, target: "reminders" });

        expect(result.reminders?.ok).toBe(true);

        if (result.reminders?.ok) {
            expect(result.reminders.alreadySynced).toBe(true);
        }

        expect(countSynced(result)).toBe(0);
    });
});

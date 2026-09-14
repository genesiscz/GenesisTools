import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditCommand } from "@app/todo/commands/edit";
import { env } from "@genesiscz/utils/env";
import { MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import { MacReminders } from "@genesiscz/utils/macos/apple-reminders";
import { TodoStore } from "../store";

/**
 * `tools todo edit` appends to `tags`, `links` and `reminders`. It used to build
 * each whole array from a snapshot read BEFORE the store lock and write it back
 * whole, so a concurrent writer's change was overwritten.
 *
 * `reminders` is the one that matters: `syncTodo` writes it too, so an
 * `--add-reminder` racing a sync could drop the identifier the sync had just
 * recorded, and the next sync would then create a second event — the defect the
 * sync path was fixed for, reached through the other door.
 *
 * Detector strength, measured 2026-09-14 by running this file against the
 * snapshot-derived version of `edit.ts` (`current.*` replaced by `existing.*`),
 * five times: both cases below failed 5 of 5. A case asserting the interaction
 * with a real `syncTodo` was tried and REMOVED — it passed 5 of 5 against the
 * broken code, because the sync's own (already safe) write happened to land
 * last and repaired the stale array. It proved nothing and it is not here.
 *
 * EventKit is mocked for the whole file: no test here may reach the real
 * calendar or Reminders.app.
 */
let TEST_DIR: string;
let SANDBOX: string;
let createEvent: Mock<typeof MacCalendar.createEvent>;
let createReminder: Mock<typeof MacReminders.createReminder>;

function newStore(): TodoStore {
    return TodoStore.forProject(TEST_DIR);
}

function runEdit(args: string[]): Promise<unknown> {
    return createEditCommand().parseAsync([...args, "--project", TEST_DIR, "-f", "json"], { from: "user" });
}

beforeEach(() => {
    SANDBOX = mkdtempSync(join(tmpdir(), "todo-edit-race-"));
    TEST_DIR = join(SANDBOX, "project");
    env.testing.set("GENESIS_TOOLS_HOME", SANDBOX);
    createEvent = spyOn(MacCalendar, "createEvent").mockResolvedValue("EVT-TEST-1");
    createReminder = spyOn(MacReminders, "createReminder").mockResolvedValue("REM-TEST-1");
});

afterEach(() => {
    createEvent.mockRestore();
    createReminder.mockRestore();
    env.testing.unset("GENESIS_TOOLS_HOME");
    rmSync(SANDBOX, { recursive: true, force: true });
});

describe("edit appends against the row at write time", () => {
    it("keeps both reminders when two --add-reminder edits run in parallel", async () => {
        const todo = await newStore().add({ title: "two writers" });

        await Promise.all([runEdit([todo.id, "--add-reminder", "1h"]), runEdit([todo.id, "--add-reminder", "2h"])]);

        const persisted = await newStore().get(todo.id);

        expect(persisted?.reminders).toHaveLength(2);
    });

    it("keeps both tags when two --add-tag edits run in parallel", async () => {
        const todo = await newStore().add({ title: "two writers" });

        await Promise.all([runEdit([todo.id, "--add-tag", "alpha"]), runEdit([todo.id, "--add-tag", "beta"])]);

        const persisted = await newStore().get(todo.id);

        expect(persisted?.tags.toSorted()).toEqual(["alpha", "beta"]);
    });

    it("never reaches the real calendar", async () => {
        const todo = await newStore().add({ title: "guarded" });

        await runEdit([todo.id, "--add-reminder", "1h", "--sync-to", "calendar"]);

        expect(createEvent).toHaveBeenCalled();
        expect(createEvent.mock.calls[0][0].calendarName).toBeUndefined();
    });
});

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAddCommand } from "@app/todo/commands/add";
import { createEditCommand } from "@app/todo/commands/edit";
import { createSyncCommand } from "@app/todo/commands/sync";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import { MacReminders } from "@genesiscz/utils/macos/apple-reminders";
import type { Todo } from "../types";

/**
 * `-f json` is the machine door, and the skill doc tells agents it stays
 * parseable. The sync line broke that: `add --sync-to calendar -f json` printed
 * the record and then `SYNC_OK …` on the SAME stream, so `JSON.parse` of stdout
 * failed on the trailing line. The identifier is inside the record already, so
 * the extra line carried nothing a JSON reader could not see.
 *
 * EventKit is mocked: no test here may reach the real calendar or Reminders.app.
 */
let TEST_DIR: string;
let SANDBOX: string;
let stdout: string[];
let println: Mock<typeof out.println>;
let createEvent: Mock<typeof MacCalendar.createEvent>;
let createReminder: Mock<typeof MacReminders.createReminder>;

beforeEach(() => {
    SANDBOX = mkdtempSync(join(tmpdir(), "todo-json-out-"));
    TEST_DIR = join(SANDBOX, "project");
    env.testing.set("GENESIS_TOOLS_HOME", SANDBOX);
    stdout = [];
    println = spyOn(out, "println").mockImplementation((line: string) => {
        stdout.push(line);
    });
    createEvent = spyOn(MacCalendar, "createEvent").mockResolvedValue("EVT-TEST-1");
    createReminder = spyOn(MacReminders, "createReminder").mockResolvedValue("REM-TEST-1");
});

afterEach(() => {
    println.mockRestore();
    createEvent.mockRestore();
    createReminder.mockRestore();
    env.testing.unset("GENESIS_TOOLS_HOME");
    rmSync(SANDBOX, { recursive: true, force: true });
});

describe("`-f json` stdout with --sync-to", () => {
    it("is a single parseable document from `add`, with the identifier inside it", async () => {
        await createAddCommand().parseAsync(
            ["slot", "--at", "2026-09-15T10:00:00.000Z", "--sync-to", "calendar", "--project", TEST_DIR, "-f", "json"],
            { from: "user" }
        );

        const parsed = SafeJSON.parse(stdout.join("\n")) as Todo;

        expect(parsed.reminders.find((r) => r.synced === "calendar")?.syncId).toBe("EVT-TEST-1");
        expect(stdout.some((line) => line.startsWith("SYNC_OK"))).toBe(false);
    });

    it("still prints the SYNC_OK line for a human format", async () => {
        await createAddCommand().parseAsync(
            ["slot", "--at", "2026-09-15T10:00:00.000Z", "--sync-to", "calendar", "--project", TEST_DIR, "-f", "md"],
            { from: "user" }
        );

        expect(stdout.some((line) => line.startsWith("SYNC_OK calendar"))).toBe(true);
    });
});

describe("edit keeps the same contract", () => {
    it("emits no SYNC_OK line under -f json and one under -f md", async () => {
        await createAddCommand().parseAsync(["slot", "--project", TEST_DIR, "-f", "json"], { from: "user" });
        const created = SafeJSON.parse(stdout.join("\n")) as Todo;
        stdout = [];

        await createEditCommand().parseAsync(
            [
                created.id,
                "--at",
                "2026-09-15T10:00:00.000Z",
                "--sync-to",
                "calendar",
                "--project",
                TEST_DIR,
                "-f",
                "json",
            ],
            { from: "user" }
        );

        const parsed = SafeJSON.parse(stdout.join("\n")) as Todo;

        expect(parsed.reminders.find((r) => r.synced === "calendar")?.syncId).toBe("EVT-TEST-1");
        expect(stdout.some((line) => line.startsWith("SYNC_OK"))).toBe(false);
    });
});

/**
 * `sync --all` promises exactly one terminal line — SYNC_SUMMARY when a todo was
 * eligible, SYNC_NOOP when none was — so a parser always sees the run close. No
 * test exercised the actual CLI door before this: `hasSyncableTime` and
 * `syncTodo` were covered directly, but never through `createSyncCommand`.
 */
describe("`sync --all` output contract", () => {
    it("ends with exactly one SYNC_SUMMARY line, after the per-todo SYNC_OK lines", async () => {
        await createAddCommand().parseAsync(
            ["slot", "--at", "2026-09-15T10:00:00.000Z", "--project", TEST_DIR, "-f", "json"],
            { from: "user" }
        );
        stdout = [];

        await createSyncCommand().parseAsync(["--all", "--to", "calendar", "--project", TEST_DIR], { from: "user" });

        // This test's NAME claims an order, so assert the order. Without the two index
        // checks below, a regression that silently stopped printing SYNC_OK in the --all
        // loop still passed, because only the summary was ever examined.
        const okIndex = stdout.findIndex((line) => line.startsWith("SYNC_OK"));
        const summaryIndex = stdout.findIndex((line) => line.startsWith("SYNC_SUMMARY"));

        expect(okIndex).toBeGreaterThanOrEqual(0);
        expect(okIndex).toBeLessThan(summaryIndex);
        expect(stdout.filter((line) => line.startsWith("SYNC_SUMMARY"))).toHaveLength(1);
        expect(stdout.at(-1)).toBe("SYNC_SUMMARY calendar ok=1 failed=0 of 1");
        expect(stdout.some((line) => line.startsWith("SYNC_NOOP"))).toBe(false);
    });

    it("emits exactly one SYNC_NOOP line when no open todo has --at or a reminder", async () => {
        await createAddCommand().parseAsync(["untimed", "--project", TEST_DIR, "-f", "json"], { from: "user" });
        stdout = [];

        await createSyncCommand().parseAsync(["--all", "--to", "calendar", "--project", TEST_DIR], { from: "user" });

        expect(stdout).toHaveLength(1);
        expect(stdout[0]).toStartWith(`SYNC_NOOP calendar ${TEST_DIR}:`);
    });

    it("counts a failed target in SYNC_SUMMARY rather than dropping it into SYNC_NOOP", async () => {
        await createAddCommand().parseAsync(
            ["a", "--at", "2026-09-15T10:00:00.000Z", "--project", TEST_DIR, "-f", "json"],
            { from: "user" }
        );
        await createAddCommand().parseAsync(
            ["b", "--at", "2026-09-15T11:00:00.000Z", "--project", TEST_DIR, "-f", "json"],
            { from: "user" }
        );
        stdout = [];
        createEvent.mockRejectedValueOnce(new Error("darwinkit crash"));

        await createSyncCommand().parseAsync(["--all", "--to", "calendar", "--project", TEST_DIR], { from: "user" });

        expect(stdout.filter((line) => line.startsWith("SYNC_SUMMARY"))).toHaveLength(1);
        expect(stdout.at(-1)).toBe("SYNC_SUMMARY calendar ok=1 failed=1 of 2");
    });
});

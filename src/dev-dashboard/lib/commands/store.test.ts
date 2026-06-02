import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { addCommand, deleteCommand, listCommands, validateCommandInput } from "./store";

let prevHome: string | undefined;

beforeEach(() => {
    prevHome = process.env.GENESIS_TOOLS_HOME;
    process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "dd-commands-"));
    resetDevDashboardStorage();
});

afterEach(() => {
    if (prevHome === undefined) {
        delete process.env.GENESIS_TOOLS_HOME;
    } else {
        process.env.GENESIS_TOOLS_HOME = prevHome;
    }

    resetDevDashboardStorage();
});

describe("commands store CRUD", () => {
    test("starts empty", async () => {
        expect(await listCommands()).toEqual([]);
    });

    test("add returns an entry with a generated id and lists it", async () => {
        const created = await addCommand({ label: "Run tests", command: "bun test" });

        expect(created.id).toBeTruthy();
        expect(created.label).toBe("Run tests");
        expect(created.command).toBe("bun test");

        const all = await listCommands();
        expect(all).toHaveLength(1);
        expect(all[0]?.id).toBe(created.id);
    });

    test("delete removes by id and reports the removed count", async () => {
        const a = await addCommand({ label: "Git status", command: "git status" });
        await addCommand({ label: "Tests", command: "bun test" });

        const removed = await deleteCommand(a.id);
        expect(removed).toBe(1);

        const all = await listCommands();
        expect(all).toHaveLength(1);
        expect(all.find((c) => c.id === a.id)).toBeUndefined();
    });

    test("delete of an unknown id removes nothing", async () => {
        expect(await deleteCommand("nope")).toBe(0);
    });

    test("persistence round-trips through commands.json", async () => {
        const created = await addCommand({ label: "Restart dev", command: "bun dev" });
        const reread = await listCommands();
        expect(reread.map((c) => c.id)).toContain(created.id);
    });
});

describe("validateCommandInput", () => {
    test("trims and accepts a valid input", () => {
        expect(validateCommandInput({ label: "  Run tests  ", command: "  bun test  " })).toEqual({
            label: "Run tests",
            command: "bun test",
        });
    });

    test("rejects empty label", () => {
        expect(() => validateCommandInput({ label: "   ", command: "bun test" })).toThrow(/label/i);
    });

    test("rejects empty command", () => {
        expect(() => validateCommandInput({ label: "Run tests", command: "  " })).toThrow(/command/i);
    });
});

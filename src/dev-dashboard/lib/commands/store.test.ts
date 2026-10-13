import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@genesiscz/utils/env";
import { addCommand, deleteCommand, listCommands, validateCommandInput } from "./store";

let prevHome: string | undefined;

beforeEach(() => {
    prevHome = env.get("GENESIS_TOOLS_HOME");
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "dd-commands-")));
    resetDevDashboardStorage();
});

afterEach(() => {
    if (prevHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", prevHome);
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

/**
 * readAll treated an unreadable commands.json as empty, and add then wrote `[newCommand]` over every
 * saved command. Listing may still show none; a rewrite must refuse and keep the bytes.
 */
describe("commands store with an unreadable commands.json", () => {
    const TRUNCATED = '[\n  { "id": "cmd-kept", "label": "Kept snippet", "command": "git sta';

    function plant(): string {
        const dir = getDevDashboardStorage().getBaseDir();
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "commands.json");
        writeFileSync(path, TRUNCATED);
        return path;
    }

    test("add and delete refuse, and the file keeps its bytes", async () => {
        const path = plant();

        await expect(addCommand({ label: "New", command: "bun test" })).rejects.toThrow(/left untouched/);
        await expect(deleteCommand("cmd-kept")).rejects.toThrow(path);
        expect(readFileSync(path, "utf8")).toBe(TRUNCATED);
    });

    test("listing still shows none instead of failing", async () => {
        plant();

        expect(await listCommands()).toEqual([]);
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

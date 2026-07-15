import { describe, expect, test } from "bun:test";
import { mergeLsofCwdFields, parsePsPidLstartCommand, shortCommandFromArgv } from "./resolve";

describe("parsePsPidLstartCommand", () => {
    test("parses pid + lstart + command", () => {
        const line = "21109 Wed Jul 15 01:36:55 2026 Cursor Helper (Plugin): extension-host (user) col-be [4-31]";
        const parsed = parsePsPidLstartCommand(line);
        expect(parsed?.pid).toBe(21109);
        expect(parsed?.command).toContain("extension-host");
        expect(parsed?.startedAtMs).toBeTypeOf("number");
    });
});

describe("mergeLsofCwdFields", () => {
    test("maps p/n fields for multiple pids", () => {
        const out = mergeLsofCwdFields(
            ["p100", "fcwd", "n/Users/a/proj", "p200", "fcwd", "n/Users/b/other", ""].join("\n")
        );
        expect(out.get(100)).toBe("/Users/a/proj");
        expect(out.get(200)).toBe("/Users/b/other");
    });
});

describe("shortCommandFromArgv", () => {
    test("Cursor → Cursor", () => {
        expect(shortCommandFromArgv("Cursor Helper (Plugin): extension-host (user) x")).toBe("Cursor");
    });

    test("path basename for node", () => {
        expect(shortCommandFromArgv("/usr/local/bin/node ./server.js")).toBe("node");
    });
});

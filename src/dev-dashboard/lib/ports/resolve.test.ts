import { describe, expect, test } from "bun:test";
import { shortCommandFromArgv } from "./resolve";

describe("shortCommandFromArgv", () => {
    test("Cursor → Cursor", () => {
        expect(shortCommandFromArgv("Cursor Helper (Plugin): extension-host (user) x")).toBe("Cursor");
    });

    test("path basename for node", () => {
        expect(shortCommandFromArgv("/usr/local/bin/node ./server.js")).toBe("node");
    });
});

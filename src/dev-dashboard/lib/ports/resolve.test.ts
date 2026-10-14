import { describe, expect, spyOn, test } from "bun:test";
import * as processes from "@genesiscz/utils/process/processes";
import { batchProcessMeta, shortCommandFromArgv } from "./resolve";

test("standalone metadata enrichment takes one snapshot of distinct valid owners", async () => {
    const snapshot = spyOn(processes, "readProcessesWithUsage").mockReturnValue([]);
    try {
        expect(await batchProcessMeta([42, 42, 43, 0, -1, Number.NaN])).toEqual(new Map());
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveBeenCalledWith([42, 43]);
    } finally {
        snapshot.mockRestore();
    }
});

describe("shortCommandFromArgv", () => {
    test("Cursor → Cursor", () => {
        expect(shortCommandFromArgv("Cursor Helper (Plugin): extension-host (user) x")).toBe("Cursor");
    });

    test("path basename for node", () => {
        expect(shortCommandFromArgv("/usr/local/bin/node ./server.js")).toBe("node");
    });
});

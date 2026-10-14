import { describe, expect, spyOn, test } from "bun:test";
import * as processOs from "@genesiscz/utils/process/os";
import * as ps from "@genesiscz/utils/process/ps";
import { collectProcesses, friendlyProcessName, killProcess, sortProcesses } from "./processes";
import type { ProcessInfo } from "./types";

const LIST: ProcessInfo[] = [
    { pid: 30, name: "bun", rssBytes: 100, uptimeMs: 0, cpuPct: 0 },
    { pid: 10, name: "Activity Monitor", rssBytes: 300, uptimeMs: 0, cpuPct: 0 },
    { pid: 20, name: "activity helper", rssBytes: 300, uptimeMs: 0, cpuPct: 0 },
    { pid: 40, name: "node", rssBytes: 200, uptimeMs: 0, cpuPct: 0 },
];

describe("sortProcesses", () => {
    test("rss descending, ties broken by pid ascending", () => {
        const sorted = sortProcesses(LIST, "rss");
        expect(sorted.map((r) => r.pid)).toEqual([10, 20, 40, 30]);

        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i - 1].rssBytes >= sorted[i].rssBytes).toBe(true);
        }
    });

    test("name ascending case-insensitive, ties broken by pid", () => {
        const sorted = sortProcesses(LIST, "name");
        expect(sorted.map((r) => r.name)).toEqual(["activity helper", "Activity Monitor", "bun", "node"]);
    });

    test("does not mutate the input", () => {
        const before = LIST.map((r) => r.pid);
        sortProcesses(LIST, "rss");
        expect(LIST.map((r) => r.pid)).toEqual(before);
    });
});

describe("friendlyProcessName", () => {
    test("extracts the .app bundle name", () => {
        expect(friendlyProcessName("/Applications/Android Studio.app/Contents/MacOS/studio")).toBe("Android Studio");
    });

    test("falls back to the binary basename", () => {
        expect(friendlyProcessName("/Users/Martin/.bun/install/global/node_modules/.bin/node")).toBe("node");
    });

    test("returns a dash for empty input", () => {
        expect(friendlyProcessName("   ")).toBe("—");
    });

    test("returns input unchanged when there is no path separator", () => {
        expect(friendlyProcessName("bun")).toBe("bun");
    });
});

describe("killProcess guards", () => {
    test("refuses pid <= 1, non-integer, NaN without throwing", () => {
        expect(killProcess(1, "bun")).toBe(false);
        expect(killProcess(0, "bun")).toBe(false);
        expect(killProcess(-5, "bun")).toBe(false);
        expect(killProcess(Number.NaN, "bun")).toBe(false);
        expect(killProcess(1.5, "bun")).toBe(false);
    });

    test("fails closed when no expected command is supplied", () => {
        // The command is what proves the pid is still the process the caller
        // listed. Without it there is nothing to verify against, so the kill
        // must be refused rather than performed unchecked.
        expect(killProcess(process.pid, "")).toBe(false);
        expect(killProcess(process.pid, "   ")).toBe(false);
    });

    test("refuses a live pid whose command does not match", () => {
        expect(killProcess(process.pid, "definitely-not-this-process")).toBe(false);
    });
});
test("collectProcesses uses one Windows snapshot for every row", async () => {
    const platform = spyOn(processOs, "processPlatform").mockReturnValue("win32");
    const capture = spyOn(ps, "captureSync").mockReturnValue({
        stderr: "",
        status: 0,
        stdout: '[{"ProcessId":81001,"Name":"worker.exe","CommandLine":"worker.exe --job fixture","WorkingSetSize":1024},{"ProcessId":81002,"Name":"helper.exe","WorkingSetSize":2048}]',
    });
    try {
        const rows = await collectProcesses();
        expect(rows.map(({ pid, name, rssBytes }) => ({ pid, name, rssBytes }))).toEqual([
            { pid: 81001, name: "worker.exe", rssBytes: 1024 },
            { pid: 81002, name: "helper.exe", rssBytes: 2048 },
        ]);
        expect(capture).toHaveBeenCalledTimes(1);
    } finally {
        capture.mockRestore();
        platform.mockRestore();
    }
});

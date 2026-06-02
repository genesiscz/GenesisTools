import { describe, expect, test } from "bun:test";
import { friendlyProcessName, killProcess, parseProcessRows, sortProcesses } from "./processes";
import type { ProcessInfo } from "./types";

// Columns: pid rss(KB) etime %cpu comm
const PS_OUT = `  4821 1887436    01:30:00 12.4 /Applications/Visual Studio Code.app/Contents/Frameworks/node
  1390 1258291 1-00:00:00  4.1 /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper
  9920  901120       10:00 61.5 /Users/Martin/.bun/bin/bun
   277  655360 20-00:00:00  2.0 /System/Library/.../WindowServer
garbage line with too few
  abc 1234       00:01:00  0.0 /usr/bin/notapid`;

describe("parseProcessRows", () => {
    const rows = parseProcessRows(PS_OUT);

    test("parses pid/rssBytes/uptimeMs/cpuPct/name for valid rows", () => {
        expect(rows).toEqual([
            { pid: 4821, rssBytes: 1887436 * 1024, uptimeMs: 5_400_000, cpuPct: 12.4, name: "Visual Studio Code" },
            { pid: 1390, rssBytes: 1258291 * 1024, uptimeMs: 86_400_000, cpuPct: 4.1, name: "Visual Studio Code" },
            { pid: 9920, rssBytes: 901120 * 1024, uptimeMs: 600_000, cpuPct: 61.5, name: "bun" },
            { pid: 277, rssBytes: 655360 * 1024, uptimeMs: 1_728_000_000, cpuPct: 2.0, name: "WindowServer" },
        ]);
    });

    test("skips malformed lines (< 5 parts and NaN pid)", () => {
        expect(rows.length).toBe(4);
        expect(rows.some((r) => Number.isNaN(r.pid))).toBe(false);
    });

    test("cpuPct of an unparseable column becomes 0", () => {
        const out = "100 2048    00:00:30 notacpu /usr/bin/foo";
        expect(parseProcessRows(out)[0].cpuPct).toBe(0);
    });
});

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
        expect(killProcess(1)).toBe(false);
        expect(killProcess(0)).toBe(false);
        expect(killProcess(-5)).toBe(false);
        expect(killProcess(Number.NaN)).toBe(false);
        expect(killProcess(1.5)).toBe(false);
    });
});

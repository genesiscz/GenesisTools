import { describe, expect, it, mock } from "bun:test";
import type { ProcessWithUsage } from "@genesiscz/utils/process/processes";
import { parseEtime, parsePsOutput, parseSwapUsage, parseVmmapSwap, readSwapProcessRows } from "./scanner";

describe("parseSwapUsage", () => {
    it("parses standard sysctl output in MB", () => {
        const out = "vm.swapusage: total = 19456.00M  used = 18617.75M  free = 838.25M  (encrypted)";
        const result = parseSwapUsage(out);
        expect(result.totalBytes).toBe(19456 * 1024 * 1024);
        expect(result.usedBytes).toBeCloseTo(18617.75 * 1024 * 1024);
        expect(result.freeBytes).toBeCloseTo(838.25 * 1024 * 1024);
    });

    it("returns zeros when output is empty", () => {
        const result = parseSwapUsage("");
        expect(result.totalBytes).toBe(0);
        expect(result.usedBytes).toBe(0);
        expect(result.freeBytes).toBe(0);
    });
});

describe("parseEtime", () => {
    it("parses MM:SS", () => {
        expect(parseEtime("01:30")).toBe(90 * 1000);
    });

    it("parses HH:MM:SS", () => {
        expect(parseEtime("01:00:00")).toBe(3600 * 1000);
    });

    it("parses D-HH:MM:SS", () => {
        expect(parseEtime("2-03:04:05")).toBe((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
    });

    it("returns 0 on garbage", () => {
        expect(parseEtime("xyz")).toBe(0);
    });
});

describe("parsePsOutput", () => {
    it("parses three rows with RSS in KB and full command names", () => {
        const out = [
            "70285 2076800 2-04:32:01 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "  411  413072 9-14:02:00 /System/Library/WindowServer",
            "14483    640      01:05 tsgo",
        ].join("\n");

        const rows = parsePsOutput(out);
        expect(rows).toHaveLength(3);
        expect(rows[0].pid).toBe(70285);
        expect(rows[0].rssBytes).toBe(2076800 * 1024);
        expect(rows[0].name).toContain("Brave Browser");
        expect(rows[2].pid).toBe(14483);
        expect(rows[2].name).toBe("tsgo");
        expect(rows[2].uptimeMs).toBe(65 * 1000);
    });

    it("skips blank lines and malformed rows", () => {
        const out = "\n  \nfoobar\n123 456 00:01 ok\n";
        const rows = parsePsOutput(out);
        expect(rows).toHaveLength(1);
        expect(rows[0].pid).toBe(123);
    });
});

describe("parseVmmapSwap", () => {
    it("parses GB swap with percent suffix", () => {
        const out =
            "Writable regions: Total=5.5G written=4.2G(76%) resident=1.9G(35%) swapped_out=2.4G(44%) unallocated=1.2G(21%)";
        expect(parseVmmapSwap(out)).toBeCloseTo(2.4 * 1024 ** 3);
    });

    it("parses MB swap", () => {
        const out =
            "Writable regions: Total=900M written=500M(55%) resident=200M(22%) swapped_out=210.5M(23%) unallocated=89.5M(10%)";
        expect(parseVmmapSwap(out)).toBeCloseTo(210.5 * 1024 ** 2);
    });

    it("parses zero swap with no unit", () => {
        const out = "Writable regions: Total=10M written=5M resident=5M swapped_out=0 unallocated=0";
        expect(parseVmmapSwap(out)).toBe(0);
    });

    it("returns 0 when no Writable regions line is present", () => {
        expect(parseVmmapSwap("garbage\noutput")).toBe(0);
    });
});

function processEntry(overrides: Partial<ProcessWithUsage> = {}): ProcessWithUsage {
    return {
        pid: 123,
        ppid: 1,
        pgid: 123,
        uid: 1000,
        name: "Example Browser",
        command: "/Applications/Example Browser.app/Contents/MacOS/Example Browser --profile work",
        tty: null,
        startMs: 100_100,
        zombie: false,
        state: "S",
        usage: { pid: 123, rssBytes: 2 * 1024 ** 2, cpuTimeMs: 500, threads: 2, running: false },
        ...overrides,
    };
}

describe("readSwapProcessRows", () => {
    it("requests other-user usage once and preserves the comm path and whole-second uptime", () => {
        const processes = mock(() => [processEntry()]);
        const executablePath = mock(() => "/Applications/Example Browser.app/Contents/MacOS/Example Browser");
        const rows = readSwapProcessRows({ processes, executablePath, now: () => 120_345 });

        expect(processes).toHaveBeenCalledTimes(1);
        expect(processes).toHaveBeenCalledWith({ otherUsers: true });
        expect(executablePath).toHaveBeenCalledWith(123);
        expect(rows).toEqual(
            parsePsOutput("123 2048 00:20 /Applications/Example Browser.app/Contents/MacOS/Example Browser")
        );

        const later = readSwapProcessRows({ processes, executablePath, now: () => 121_100 });
        expect(later[0].uptimeMs).toBe(21_000);
        // Quantizing etime must not make this unchanged process look five seconds younger or older.
        expect(Math.abs(120_345 - rows[0].uptimeMs - (121_100 - later[0].uptimeMs))).toBeLessThan(1000);
    });

    it("skips unavailable usage and start times without inventing cache identities", () => {
        const executablePath = mock(() => "/unused");
        const rows = readSwapProcessRows({
            processes: () => [processEntry({ usage: null }), processEntry({ pid: 124, startMs: null })],
            executablePath,
            now: () => 120_345,
        });

        expect(rows).toEqual([]);
        expect(executablePath).not.toHaveBeenCalled();
    });

    it("an empty table is unknown and throws instead of reporting no processes", () => {
        expect(() => readSwapProcessRows({ processes: () => [] })).toThrow("swap process table unavailable");
    });

    it("keeps a layer read failure visible", () => {
        expect(() =>
            readSwapProcessRows({
                processes: () => {
                    throw new Error("table read failed");
                },
            })
        ).toThrow("table read failed");
    });

    it("uses the command executable, without its arguments, when the path is unavailable", () => {
        const rows = readSwapProcessRows({
            processes: () => [processEntry({ command: "/usr/sbin/exampled --foreground", name: "exampled" })],
            executablePath: () => null,
            now: () => 120_345,
        });

        expect(rows[0].name).toBe("/usr/sbin/exampled");
    });
});

import { describe, expect, mock, test } from "bun:test";
import { logger } from "@app/logger";
import {
    parseBattery,
    parseCpuIdlePct,
    parseDfRoot,
    parseMemoryFreePct,
    parseVmStat,
    parseWifiSsid,
} from "./collector";

const TOP_OUT = `Processes: 1790 total, 17 running, 1773 sleeping, 14680 threads
2026/05/15 16:45:26
Load Avg: 17.30, 24.84, 21.08
CPU usage: 58.2% user, 25.24% sys, 16.72% idle
SharedLibs: 1583M resident, 216M data, 472M linkedit.`;

const VMSTAT_OUT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              157320.
Pages active:                           2287697.
Pages inactive:                         2280455.
Pages speculative:                         5348.
Pages throttled:                              0.
Pages wired down:                        781045.
Pages purgeable:                          24103.
Pages occupied by compressor:            2818240.`;

const PMSET_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22151267)\t93%; discharging; 1:42 remaining present: true`;

const PMSET_NO_BATTERY = `Now drawing from 'AC Power'
 No batteries available`;

const DF_OUT = `Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s1s1   971350180  12165836  22515576    36%  455008 225155760    0%   /`;

const WIFI_CONNECTED = "Current Wi-Fi Network: MyHomeNet";
const WIFI_NOT_ASSOCIATED = "You are not associated with an AirPort network.";

describe("parseCpuIdlePct", () => {
    test("returns 100 - idle rounded to 1 decimal", () => {
        expect(parseCpuIdlePct(TOP_OUT)).toBe(83.3);
    });

    test("returns null on unparseable output", () => {
        expect(parseCpuIdlePct("garbage")).toBeNull();
    });
});

describe("parseMemoryFreePct", () => {
    test("parses system-wide free percentage", () => {
        const out = "System-wide memory free percentage: 65%";
        expect(parseMemoryFreePct(out)).toBe(65);
    });

    test("returns null when missing", () => {
        expect(parseMemoryFreePct("no stats")).toBeNull();
    });
});

describe("parseVmStat", () => {
    test("sums active + wired + compressed times page size", () => {
        const expected = (2287697 + 781045 + 2818240) * 16384;
        expect(parseVmStat(VMSTAT_OUT, 16384)).toEqual({ usedBytes: expected });
    });
});

describe("parseBattery", () => {
    test("parses percent and state for laptop", () => {
        expect(parseBattery(PMSET_BATTERY)).toEqual({ pct: 93, state: "discharging" });
    });

    test("returns nulls when no battery", () => {
        expect(parseBattery(PMSET_NO_BATTERY)).toEqual({ pct: null, state: null });
    });
});

describe("parseDfRoot", () => {
    test("converts 1K blocks to bytes", () => {
        expect(parseDfRoot(DF_OUT)).toEqual({
            freeBytes: 22515576 * 1024,
            totalBytes: 971350180 * 1024,
        });
    });

    test("returns nulls on bad output", () => {
        expect(parseDfRoot("Filesystem\n")).toEqual({ freeBytes: null, totalBytes: null });
    });
});

describe("parseWifiSsid", () => {
    test("parses connected network", () => {
        expect(parseWifiSsid(WIFI_CONNECTED)).toBe("MyHomeNet");
    });

    test("returns null when not associated", () => {
        expect(parseWifiSsid(WIFI_NOT_ASSOCIATED)).toBeNull();
    });
});

describe("collectTopProcesses", () => {
    test("uses a cheaper top-N path instead of enumerating + sorting every process", async () => {
        const spawnSpy = mock(Bun.spawn);
        const original = Bun.spawn;
        // @ts-expect-error -- intentional test override
        Bun.spawn = spawnSpy;

        try {
            const { collectTopProcesses } = await import("./collector");
            await collectTopProcesses(5);

            const psCall = spawnSpy.mock.calls.find((c) => Array.isArray(c[0]) && c[0][0] === "ps");
            expect(psCall).toBeDefined();
            const argv = psCall?.[0] as string[];
            expect(argv.some((a) => a.includes("-r") || a.includes("-m"))).toBe(true);
        } finally {
            Bun.spawn = original;
        }
    });
});

describe("runShell", () => {
    test("logs at debug level when the spawned command fails to spawn", async () => {
        const debugSpy = mock(() => {});
        const original = logger.debug;
        logger.debug = debugSpy;

        try {
            const { runShell } = await import("./collector");
            const result = await runShell(["/nonexistent-binary-xyz123"]);

            expect(result).toBeNull();
            expect(debugSpy).toHaveBeenCalled();
        } finally {
            logger.debug = original;
        }
    });

    test("logs at debug level when the command exits non-zero, including captured stderr", async () => {
        const debugSpy = mock((..._args: unknown[]) => {});
        const original = logger.debug;
        logger.debug = debugSpy;

        try {
            const { runShell } = await import("./collector");
            const result = await runShell(["sh", "-c", "echo 'boom' >&2; exit 1"]);

            expect(result).toBeNull();
            expect(debugSpy).toHaveBeenCalled();
            const [payload] = debugSpy.mock.calls[0] ?? [];
            expect((payload as { stderr?: string }).stderr).toContain("boom");
        } finally {
            logger.debug = original;
        }
    });
});

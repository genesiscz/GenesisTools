import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpuBusyPercent,
    hostStatsAvailable,
    readCpuTicks,
    readMemoryFreePercent,
    readMemorySizeBytes,
    readSwapUsage,
    readVmPageCounts,
    sampleCpuBusyPercent,
} from "@genesiscz/utils/macos/host-stats";

const IS_MAC = process.platform === "darwin";

function systemText(command: string, args: string[]): string {
    return spawnSync(command, args, { encoding: "utf8" }).stdout ?? "";
}

/** One `vm_stat` line's page count, e.g. `Pages wired down:  447870.` */
function vmStatPages(output: string, label: string): number {
    const match = output.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m"));
    return match ? Number(match[1]) : Number.NaN;
}

describe("cpuBusyPercent", () => {
    test("is the busy share of the ticks that passed, to one decimal, like 100 - top's idle", () => {
        const previous = { user: 100, system: 50, idle: 800, nice: 0 };
        const current = { user: 160, system: 70, idle: 1100, nice: 3 };

        // 83 busy ticks of 383.
        expect(cpuBusyPercent(previous, current)).toBe(21.7);
    });

    test("answers null when no tick passed, rather than dividing by zero", () => {
        const ticks = { user: 1, system: 2, idle: 3, nice: 0 };

        expect(cpuBusyPercent(ticks, { ...ticks })).toBeNull();
    });

    test("survives the 32-bit counters wrapping after weeks of uptime", () => {
        const previous = { user: 0xffffff00, system: 10, idle: 0xfffffff0, nice: 0 };
        const current = { user: 0x00000040, system: 20, idle: 0x00000100, nice: 0 };
        // user advanced 0x140 = 320, system 10, idle 0x110 = 272.

        expect(cpuBusyPercent(previous, current)).toBe(Math.round((330 / 602) * 1000) / 10);
    });
});

describe.skipIf(!IS_MAC)("host stats on this Mac", () => {
    test("read the same figures the system tools print", () => {
        const vmStat = systemText("vm_stat", []);
        const pages = readVmPageCounts();
        const pressure = systemText("memory_pressure", []).match(/free percentage:\s*(\d+)%/);
        const swapText = systemText("sysctl", ["vm.swapusage"]);

        expect(hostStatsAvailable()).toBe(true);
        expect(readMemorySizeBytes()).toBe(Number(systemText("sysctl", ["-n", "hw.memsize"]).trim()));
        expect(pages?.pageSize).toBe(Number(systemText("sysctl", ["-n", "hw.pagesize"]).trim()));
        // The counters move between the two reads; wired memory and the page total barely do.
        expect(Math.abs((pages?.wired ?? Number.NaN) - vmStatPages(vmStat, "Pages wired down"))).toBeLessThan(
            vmStatPages(vmStat, "Pages wired down") * 0.1
        );
        expect(
            Math.abs((pages?.compressed ?? Number.NaN) - vmStatPages(vmStat, "Pages occupied by compressor"))
        ).toBeLessThanOrEqual(vmStatPages(vmStat, "Pages occupied by compressor") * 0.1 + 1000);
        expect(Math.abs((readMemoryFreePercent() ?? Number.NaN) - Number(pressure?.[1]))).toBeLessThanOrEqual(5);
        expect(readSwapUsage()?.encrypted).toBe(swapText.includes("(encrypted)"));
        expect(readSwapUsage()?.totalBytes).toBe(
            Math.round(Number(swapText.match(/total = ([\d.]+)M/)?.[1]) * 1024 * 1024)
        );
    });

    test("count `vm_stat`'s free pages, which leave the speculative ones out", () => {
        const pages = readVmPageCounts();
        const vmStatFree = vmStatPages(systemText("vm_stat", []), "Pages free");
        const free = pages?.free ?? Number.NaN;
        const rawFreeCount = free + (pages?.speculative ?? Number.NaN);

        // The pages move between the two reads, but far less than the speculative pool the raw count includes.
        expect(Math.abs(free - vmStatFree)).toBeLessThanOrEqual(Math.abs(rawFreeCount - vmStatFree));
    });

    test("the CPU sample waits its minimum interval on the first call and after a quick second call", async () => {
        const ticks = readCpuTicks();
        const started = performance.now();
        const first = await sampleCpuBusyPercent(40);
        const afterFirst = performance.now();
        const second = await sampleCpuBusyPercent(40);

        expect(ticks).not.toBeNull();
        expect(afterFirst - started).toBeGreaterThanOrEqual(35);
        expect(performance.now() - afterFirst).toBeGreaterThanOrEqual(35);

        // The counters can stand still for most of a second, so 40 ms may honestly have no figure.
        for (const value of [first, second]) {
            expect(value === null || (value >= 0 && value <= 100)).toBe(true);
        }
    });

    test("over the default interval it answers a figure", async () => {
        const value = await sampleCpuBusyPercent();

        expect(value ?? Number.NaN).toBeGreaterThanOrEqual(0);
        expect(value ?? Number.NaN).toBeLessThanOrEqual(100);
    });
});

describe.skipIf(IS_MAC)("host stats off macOS", () => {
    test("every reader answers null, so the callers keep their own commands", async () => {
        expect(hostStatsAvailable()).toBe(false);
        expect(readCpuTicks()).toBeNull();
        expect(readVmPageCounts()).toBeNull();
        expect(readMemorySizeBytes()).toBeNull();
        expect(readMemoryFreePercent()).toBeNull();
        expect(readSwapUsage()).toBeNull();
        expect(await sampleCpuBusyPercent(1)).toBeNull();
    });
});

import { describe, expect, test } from "bun:test";
import { skip } from "@genesiscz/utils/test/skip";
import {
    parseCpuTime,
    parseProcRssBytes,
    parseProcStatCpuMs,
    parseProcThreads,
    sampleProcess,
    sampleSelf,
} from "./process-sample";

const WINDOW_MS = 100;

describe("parseCpuTime", () => {
    test("parses the macOS mm:ss.cc shape", () => {
        expect(parseCpuTime("0:00.01")).toBe(10);
        expect(parseCpuTime("12:34.56")).toBe(754_560);
    });

    test("parses the hh:mm:ss shape Linux prints", () => {
        expect(parseCpuTime("01:02:03")).toBe(3_723_000);
    });

    test("parses the dd-hh:mm:ss shape a multi-day daemon gets", () => {
        expect(parseCpuTime("5-23:12:45")).toBe(5 * 86_400_000 + 83_565_000);
    });

    test("returns null rather than zero for something it cannot read", () => {
        expect(parseCpuTime("")).toBeNull();
        expect(parseCpuTime("   ")).toBeNull();
        expect(parseCpuTime("not-a-time")).toBeNull();
        expect(parseCpuTime("1:2:3:4")).toBeNull();
    });
});

describe("Linux /proc parsers", () => {
    const status = ["Name:\tbun", "Threads:\t7", "VmRSS:\t   12345 kB", "State:\tS (sleeping)"].join("\n");

    test("reads the thread count", () => {
        expect(parseProcThreads(status)).toBe(7);
        expect(parseProcThreads("Name:\tbun")).toBeNull();
    });

    test("reads RSS in bytes", () => {
        expect(parseProcRssBytes(status)).toBe(12_345 * 1024);
    });

    test("reads utime + stime past a comm field containing spaces and parens", () => {
        const fields = Array.from({ length: 30 }, (_, i) => String(i + 3));
        fields[11] = "100";
        fields[12] = "50";
        const stat = `4242 (my weird ) name) ${fields.join(" ")}`;

        // 150 ticks at 100 Hz is 1.5 seconds.
        expect(parseProcStatCpuMs(stat)).toBe(1500);
        expect(parseProcStatCpuMs("no close paren here")).toBeNull();
    });
});

describe("sampleSelf", () => {
    test("attributes a busy loop inside the window to this process", async () => {
        const pending = sampleSelf({ windowMs: WINDOW_MS, countThreads: false });
        const spinUntil = performance.now() + 50;
        let spins = 0;

        while (performance.now() < spinUntil) {
            spins += 1;
        }

        const sample = await pending;

        expect(spins).toBeGreaterThan(0);
        expect(sample.alive).toBe(true);
        expect(sample.pid).toBe(process.pid);
        expect(sample.windowMs).toBeGreaterThanOrEqual(50);
        // Deliberately loose: under a loaded machine the spin gets descheduled, so
        // the floor proves attribution (an idle window reads near zero) rather
        // than pinning a number this suite cannot control.
        expect(sample.cpuTimeMs).toBeGreaterThan(10);
        expect(sample.cpuPercent).toBeGreaterThan(5);
        expect(sample.rssBytes).toBeGreaterThan(0);
    });

    test("skips the thread count when asked, so a hot loop costs no spawn", async () => {
        const sample = await sampleSelf({ windowMs: 10, countThreads: false });

        expect(sample.threads).toBe(0);
    });
});

describe.skipIf(skip.onWindows)("sampleProcess", () => {
    test("measures a live pid over the window", async () => {
        const sample = await sampleProcess(process.pid, { windowMs: WINDOW_MS });

        expect(sample.alive).toBe(true);
        expect(sample.pid).toBe(process.pid);
        expect(sample.windowMs).toBeGreaterThanOrEqual(WINDOW_MS - 5);
        expect(sample.cpuTimeMs).toBeGreaterThanOrEqual(0);
        expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(sample.rssBytes).toBeGreaterThan(0);
        expect(sample.threads).toBeGreaterThanOrEqual(1);
    });

    test("reports a pid that does not exist as not alive instead of as idle", async () => {
        // PID 0 is the kernel scheduler; `ps -p 0` reports nothing on macOS and Linux.
        const sample = await sampleProcess(0, { windowMs: 10 });

        expect(sample.alive).toBe(false);
        expect(sample.cpuTimeMs).toBe(0);
        expect(sample.cpuPercent).toBe(0);
    });
});

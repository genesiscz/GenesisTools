import { describe, expect, test } from "bun:test";
import { monitorLoopStalls } from "./loop-stall";

describe("monitorLoopStalls", () => {
    test("reports a synchronous block as a stall of about its length", async () => {
        const monitor = monitorLoopStalls({ tickMs: 5 });
        await Bun.sleep(20);
        Bun.sleepSync(60);
        await Bun.sleep(20);
        const report = monitor.stop();

        expect(report.ticks).toBeGreaterThan(0);
        expect(report.maxStallMs).toBeGreaterThanOrEqual(50);
        expect(report.p99StallMs).toBeLessThanOrEqual(report.maxStallMs);
        expect(report.windowMs).toBeGreaterThanOrEqual(90);
    });

    test("stallsOver counts only the ticks past the threshold", async () => {
        const monitor = monitorLoopStalls({ tickMs: 5 });
        await Bun.sleep(15);
        Bun.sleepSync(60);
        await Bun.sleep(15);
        const report = monitor.stop();

        expect(report.stallsOver(50)).toBeGreaterThanOrEqual(1);
        expect(report.stallsOver(50)).toBeLessThanOrEqual(report.stallsOver(0));
        expect(report.stallsOver(10_000)).toBe(0);
    });

    test("stop is idempotent, so a second call cannot report a longer window", async () => {
        const monitor = monitorLoopStalls({ tickMs: 5 });
        await Bun.sleep(20);
        const first = monitor.stop();
        await Bun.sleep(20);
        const second = monitor.stop();

        expect(second.windowMs).toBe(first.windowMs);
        expect(second.ticks).toBe(first.ticks);
    });

    test("an empty window reports zeros rather than NaN", () => {
        const report = monitorLoopStalls({ tickMs: 5 }).stop();

        expect(report.ticks).toBe(0);
        expect(report.maxStallMs).toBe(0);
        expect(report.p99StallMs).toBe(0);
        expect(report.stallsOver(0)).toBe(0);
    });
});

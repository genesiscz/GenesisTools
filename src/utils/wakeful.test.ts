import { afterEach, describe, expect, test } from "bun:test";
import { startWakefulInterval, wakefulSleep } from "./wakeful";

describe("wakeful", () => {
    afterEach(() => {
        Bun.sleepSync(0);
    });

    test("wakefulSleep resolves after the requested delay", async () => {
        const started = Date.now();
        await wakefulSleep(50);
        expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });

    test("wakefulSleep aborts when shouldAbort returns true", async () => {
        let aborted = false;

        const sleepPromise = wakefulSleep(5_000, {
            shouldAbort: () => aborted,
        });

        aborted = true;
        await sleepPromise;
    });

    // shouldAbort runs once per loop iteration, so it counts them. A tick of 0 used to survive
    // Math.min and spin thousands of immediate awaits until the deadline, burning a core.
    test.each([0, -5, Number.NaN])("a tickMs of %p falls back to the default instead of spinning", async (tickMs) => {
        let iterations = 0;

        await wakefulSleep(60, {
            tickMs,
            shouldAbort: () => {
                iterations++;
                return false;
            },
        });

        expect(iterations).toBeLessThan(5);
    });

    test("startWakefulInterval fires tick and can be stopped", async () => {
        let ticks = 0;
        const handle = startWakefulInterval(30, () => {
            ticks++;
        });

        await Bun.sleep(80);
        handle.stop();
        await Bun.sleep(40);

        expect(ticks).toBeGreaterThanOrEqual(1);
    });
});

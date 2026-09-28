import { expect, test } from "bun:test";
import { withInterrupt } from "./interrupt";

test("copies of one Ctrl-C abort once; a later separate Ctrl-C forces the exit", async () => {
    let clock = 1000;
    let forced = 0;
    let announced = 0;
    await withInterrupt(
        async (signal) => {
            process.emit("SIGINT");
            process.emit("SIGINT");
            clock += 15;
            process.emit("SIGINT");
            expect(signal.aborted).toBe(true);
            expect([announced, forced]).toEqual([1, 0]);
            clock += 2000;
            process.emit("SIGINT");
            expect(forced).toBe(1);
        },
        {
            now: () => clock,
            onInterrupt: () => announced++,
            forceExit: () => forced++,
        }
    );
    expect(process.listenerCount("SIGINT")).toBe(0);
});

test("a copy that lands after fn settled, inside the window, is still ignored", async () => {
    let clock = 1000;
    let forced = 0;
    await withInterrupt(
        async (signal) => {
            process.emit("SIGINT");
            expect(signal.aborted).toBe(true);
        },
        { now: () => clock, forceExit: () => forced++, duplicateWindowMs: 20 }
    );
    // Without a listener, a real forwarded copy would take the default action and end the process.
    expect(process.listenerCount("SIGINT")).toBe(1);
    clock += 15;
    process.emit("SIGINT");
    expect(forced).toBe(0);
    await Bun.sleep(40);
    expect(process.listenerCount("SIGINT")).toBe(0);
});

test("a run that was never interrupted leaves no listener behind", async () => {
    await withInterrupt(async () => undefined);
    expect(process.listenerCount("SIGINT")).toBe(0);
});

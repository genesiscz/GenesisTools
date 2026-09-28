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

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { INTERRUPTED_EXIT_CODE, observeInterrupts, withInterrupt } from "./interrupt";

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

/** A stand-in for `process`: signals and exit are events, `kill` is recorded instead of delivered. */
function fakeProcess() {
    const emitter = new EventEmitter();
    const kills: string[] = [];
    const target = Object.assign(emitter, {
        pid: 4242,
        exitCode: undefined as number | undefined,
        kill: (_pid: number, signal: string) => {
            kills.push(signal);
            return true;
        },
    });
    return { target, kills };
}

test("a Ctrl-C the tool handles turns a clean exit into 130 and keeps other codes", () => {
    for (const [code, expected] of [
        [0, INTERRUPTED_EXIT_CODE],
        [2, undefined],
    ] as const) {
        const { target, kills } = fakeProcess();
        observeInterrupts(target as unknown as NodeJS.Process);
        target.once("SIGINT", () => {});
        target.emit("SIGINT");
        target.emit("exit", code);

        expect(target.exitCode).toBe(expected);
        expect(kills).toEqual([]);
    }
});

test("without a handler of its own the observer re-raises, so the default action still ends the process", () => {
    const { target, kills } = fakeProcess();
    observeInterrupts(target as unknown as NodeJS.Process);
    target.emit("SIGINT");

    expect(kills).toEqual(["SIGINT"]);
    expect(target.listenerCount("SIGINT")).toBe(0);
});

test("observing twice still re-raises an unhandled Ctrl-C, once", () => {
    const { target, kills } = fakeProcess();
    observeInterrupts(target as unknown as NodeJS.Process);
    observeInterrupts(target as unknown as NodeJS.Process);
    target.emit("SIGINT");

    expect(kills).toEqual(["SIGINT"]);
});

test("no Ctrl-C, no change: a clean exit stays 0", () => {
    const { target } = fakeProcess();
    observeInterrupts(target as unknown as NodeJS.Process);
    target.emit("exit", 0);

    expect(target.exitCode).toBeUndefined();
});

test("a real process that stops cleanly on SIGINT exits 130", async () => {
    const script = [
        `import { observeInterrupts } from "${join(import.meta.dir, "interrupt.ts")}";`,
        "observeInterrupts();",
        "const timer = setInterval(() => {}, 1000);",
        'process.once("SIGINT", () => clearInterval(timer));',
        'process.kill(process.pid, "SIGINT");',
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "-e", script], {
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
    });

    expect(await proc.exited).toBe(INTERRUPTED_EXIT_CODE);
});

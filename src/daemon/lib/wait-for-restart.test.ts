import { describe, expect, test } from "bun:test";
import { defaultIsAlive, defaultKill, stopWithEscalation } from "./wait-for-restart";

function errnoException(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

// All seams injected — no real signals, no real sleeps.
const instantSleep = async (): Promise<void> => {};

describe("stopWithEscalation", () => {
    test("already-dead process: no signals sent", async () => {
        const sent: string[] = [];

        const result = await stopWithEscalation(4242, {
            isAlive: () => false,
            kill: (_pid, signal) => {
                sent.push(signal);
            },
            sleep: instantSleep,
            firstGraceMs: 10,
            secondGraceMs: 10,
            killGraceMs: 10,
        });

        expect(result).toEqual({ exited: true, step: null });
        expect(sent).toEqual([]);
    });

    test("cooperative daemon dies on the first SIGTERM", async () => {
        const sent: string[] = [];
        let alive = true;

        const result = await stopWithEscalation(4242, {
            isAlive: () => alive,
            kill: (_pid, signal) => {
                sent.push(signal);
                alive = false; // exits promptly on the graceful signal
            },
            sleep: instantSleep,
            firstGraceMs: 50,
            secondGraceMs: 50,
            killGraceMs: 50,
        });

        expect(result).toEqual({ exited: true, step: "sigterm" });
        expect(sent).toEqual(["SIGTERM"]);
    });

    test("wedged daemon (Jul 6/8 incident): ignores SIGTERMs, dies only to SIGKILL", async () => {
        const sent: string[] = [];
        let alive = true;

        const result = await stopWithEscalation(4242, {
            isAlive: () => alive,
            kill: (_pid, signal) => {
                sent.push(signal);

                if (signal === "SIGKILL") {
                    alive = false; // the kernel doesn't need cooperation
                }
            },
            sleep: instantSleep,
            firstGraceMs: 10,
            secondGraceMs: 10,
            killGraceMs: 10,
        });

        expect(result).toEqual({ exited: true, step: "sigkill" });
        expect(sent).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    });

    test("second SIGTERM finishes a daemon whose repeat-signal handler force-exits", async () => {
        const sent: string[] = [];
        let alive = true;

        const result = await stopWithEscalation(4242, {
            isAlive: () => alive,
            kill: (_pid, signal) => {
                sent.push(signal);

                if (sent.length === 2 && signal === "SIGTERM") {
                    alive = false; // scheduler's signalCount>1 branch exits immediately
                }
            },
            sleep: instantSleep,
            firstGraceMs: 10,
            secondGraceMs: 10,
            killGraceMs: 10,
        });

        expect(result).toEqual({ exited: true, step: "sigterm-again" });
        expect(sent).toEqual(["SIGTERM", "SIGTERM"]);
    });
});

describe("defaultIsAlive / defaultKill", () => {
    test("EPERM: process exists but belongs to another user — alive, and kill doesn't throw", () => {
        const original = process.kill;
        process.kill = (() => {
            throw errnoException("EPERM");
        }) as typeof process.kill;

        try {
            expect(defaultIsAlive(4242)).toBe(true);
            expect(() => defaultKill(4242, "SIGTERM")).not.toThrow();
        } finally {
            process.kill = original;
        }
    });

    test("ESRCH: process is gone — dead, and kill doesn't throw", () => {
        const original = process.kill;
        process.kill = (() => {
            throw errnoException("ESRCH");
        }) as typeof process.kill;

        try {
            expect(defaultIsAlive(4242)).toBe(false);
            expect(() => defaultKill(4242, "SIGTERM")).not.toThrow();
        } finally {
            process.kill = original;
        }
    });

    test("other errno (EINVAL): kill rethrows", () => {
        const original = process.kill;
        process.kill = (() => {
            throw errnoException("EINVAL");
        }) as typeof process.kill;

        try {
            expect(() => defaultKill(4242, "SIGTERM")).toThrow();
        } finally {
            process.kill = original;
        }
    });
});

import { describe, expect, mock, test } from "bun:test";
import type { Plan } from "./capture-plan";

/**
 * The UNIT of the duration handed to peekaboo.
 *
 * `peekaboo capture live --help`: "Duration; bare values are milliseconds
 * (default 60s, max 180s)". The plan declares seconds (`capture-plan.ts`:
 * `duration: number; // seconds`), so the runner must convert at the boundary.
 * It did not: a `duration: 9` plan asked for 9 MILLISECONDS while the runner's
 * own exit budget waited `9 * 1000 + 30_000` ms for it.
 *
 * Nothing downstream catches that. Peekaboo still exits 0, still writes a
 * session dir and still emits a frame, so the argv is the only place the unit
 * can be pinned — hence a test that asserts argv and never spawns anything.
 *
 * `startCapture` is stubbed and throws, so the real recorder never runs. The
 * plans below also use a 2x2 pixel region rather than `mode: "screen"`: if the
 * stub ever stopped intercepting, the fallback must not record the user's
 * screen.
 */

const realPeekaboo = await import("./peekaboo");
const captured: string[][] = [];
const STUB_STOP = "stub: peekaboo is never spawned from tests";

mock.module("./peekaboo", () => ({
    ...realPeekaboo,
    startCapture: async (args: string[]) => {
        captured.push(args);
        throw new Error(STUB_STOP);
    },
}));

const { runCapturePlan } = await import("./capture-runner");

/**
 * The argv `runCapturePlan` hands to peekaboo for a plan of `duration` seconds.
 *
 * `backend: "peekaboo"` is REQUIRED, not decoration: the native ScreenCaptureKit recorder is
 * the default now, and its own `--duration` is seconds, so a default-backend plan never
 * reaches the peekaboo boundary this file exists to pin. Asking for peekaboo explicitly keeps
 * the assertion about the boundary rather than about which backend happens to be default.
 */
async function peekabooArgv(duration: number): Promise<string[]> {
    captured.length = 0;
    const plan: Plan = {
        capture: { mode: "region", region: "0,0,2,2", duration, backend: "peekaboo" },
        actions: [],
    };
    await expect(runCapturePlan(plan)).rejects.toThrow(STUB_STOP);
    expect(captured).toHaveLength(1);
    return captured[0];
}

describe("capture duration crosses the peekaboo boundary in peekaboo's unit", () => {
    test("a 9 second plan asks peekaboo for 9s, never a bare 9", async () => {
        const argv = await peekabooArgv(9);

        // argv[0] is the binary name: the native backend falls back to peekaboo by swapping
        // the attempt, so every recorder now names the binary that actually ran.
        expect(argv[0]).toBe("peekaboo");
        expect(argv.slice(1, 7)).toEqual(["capture", "live", "--mode", "region", "--duration", "9s"]);

        const value = argv[argv.indexOf("--duration") + 1];
        expect(value).toBe("9s");
        // a bare "9" is nine milliseconds to peekaboo, which is the bug
        expect(value).not.toBe("9");
    });

    test("every plan duration carries the suffix, so none is read as milliseconds", async () => {
        for (const seconds of [1, 3, 12]) {
            const argv = await peekabooArgv(seconds);

            expect(argv[argv.indexOf("--duration") + 1]).toBe(`${seconds}s`);
        }
    });
});

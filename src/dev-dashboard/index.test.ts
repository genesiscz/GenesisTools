import { describe, expect, test } from "bun:test";

describe("killChild", () => {
    test("escalates to SIGKILL if the child ignores SIGTERM within the grace period", async () => {
        const { killWithEscalation: killChild } = await import("@genesiscz/utils/process/killWithEscalation");

        const proc = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30"], { env: process.env });
        await new Promise((r) => setTimeout(r, 100));

        const exited = await killChild(proc, { graceMs: 500 });

        expect(exited).toBe(true);
        expect(proc.killed).toBe(true);
    });

    test("a child that is not reaped after SIGKILL answers false at the reap deadline instead of waiting forever", async () => {
        const { killWithEscalation: killChild } = await import("@genesiscz/utils/process/killWithEscalation");
        const signals: string[] = [];
        // A child stuck in uninterruptible sleep: it takes both signals and never exits.
        const stuck = {
            kill: (signal?: NodeJS.Signals | number) => {
                signals.push(String(signal));
            },
            exited: new Promise<number>(() => {}),
            exitCode: null,
        };
        const guard = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000));
        const started = Date.now();

        expect(await Promise.race([killChild(stuck, { graceMs: 20, reapMs: 50 }), guard])).toBe(false);
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

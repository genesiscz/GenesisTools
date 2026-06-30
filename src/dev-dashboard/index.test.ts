import { describe, expect, test } from "bun:test";

describe("killChild", () => {
    test("escalates to SIGKILL if the child ignores SIGTERM within the grace period", async () => {
        const { killChild } = await import("./index");

        const proc = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30"]);
        await new Promise((r) => setTimeout(r, 100));

        const exited = await killChild(proc, { graceMs: 500 });

        expect(exited).toBe(true);
        expect(proc.killed).toBe(true);
    });
});
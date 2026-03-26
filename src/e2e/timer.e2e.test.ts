import { afterAll, describe, expect, it } from "bun:test";
import { getOutput, runTool } from "@app/utils/e2e/helpers";

describe("tools timer", () => {
    afterAll(async () => {
        await runTool(["timer", "cancel"]);
    });

    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await runTool(["timer", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Focus timer");
        });

        it("--help shows all options", async () => {
            const r = await runTool(["timer", "--help"]);
            for (const flag of ["--notify", "--say", "--bg", "--repeat"]) {
                expect(r.stdout).toContain(flag);
            }
        });

        it("list --help exits 0", async () => {
            const r = await runTool(["timer", "list", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("cancel --help exits 0", async () => {
            const r = await runTool(["timer", "cancel", "--help"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("list subcommand", () => {
        it("list exits 0", async () => {
            const r = await runTool(["timer", "list"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("cancel subcommand", () => {
        it("cancel exits 0 when no timers", async () => {
            const r = await runTool(["timer", "cancel"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("background timer lifecycle", () => {
        it("starts bg timer, lists it, waits for expiry", async () => {
            const start = await runTool(["timer", "3s", "e2e-bg", "--bg"]);
            expect(start.exitCode).toBe(0);
            expect(getOutput(start)).toMatch(/timer|started|background/i);

            const list = await runTool(["timer", "list"]);
            expect(list.exitCode).toBe(0);
            expect(getOutput(list)).toContain("e2e-bg");

            await Bun.sleep(4000);

            const listAfter = await runTool(["timer", "list"]);
            expect(listAfter.exitCode).toBe(0);
        }, 10_000);
    });

    describe("cancel lifecycle", () => {
        it("starts and cancels a timer", async () => {
            const start = await runTool(["timer", "60s", "cancel-me", "--bg"]);
            expect(start.exitCode).toBe(0);

            const cancel = await runTool(["timer", "cancel"]);
            expect(cancel.exitCode).toBe(0);

            const list = await runTool(["timer", "list"]);
            expect(list.exitCode).toBe(0);
        });
    });
});

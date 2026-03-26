import { afterAll, describe, expect, it } from "bun:test";
import { getOutput, runTool } from "@app/utils/e2e/helpers";

describe("tools say", () => {
    afterAll(async () => {
        await runTool(["say", "--unmute"]);
        await runTool(["say", "--unmute", "--app", "e2e-test"]);
    });

    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await runTool(["say", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Text-to-speech");
        });

        it("--help shows all options", async () => {
            const r = await runTool(["say", "--help"]);
            for (const flag of ["--volume", "--voice", "--rate", "--wait", "--app", "--mute", "--unmute"]) {
                expect(r.stdout).toContain(flag);
            }
        });
    });

    describe("mute lifecycle", () => {
        it("--mute exits 0", async () => {
            const r = await runTool(["say", "--mute"]);
            expect(r.exitCode).toBe(0);
        });

        it("speech while muted reports muted", async () => {
            await runTool(["say", "--mute"]);
            const r = await runTool(["say", "should be muted"]);
            expect(r.exitCode).toBe(0);
            expect(getOutput(r).toLowerCase()).toContain("muted");
        });

        it("--unmute exits 0", async () => {
            const r = await runTool(["say", "--unmute"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("per-app mute", () => {
        it("--mute --app e2e-test exits 0", async () => {
            const r = await runTool(["say", "--mute", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
        });

        it("speech with muted app reports muted", async () => {
            await runTool(["say", "--mute", "--app", "e2e-test"]);
            const r = await runTool(["say", "test", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
            expect(getOutput(r).toLowerCase()).toContain("muted");
        });

        it("--unmute --app e2e-test exits 0", async () => {
            const r = await runTool(["say", "--unmute", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("speech options", () => {
        // macOS `say` command hangs when spawned from subprocess (no TTY audio context)
        // These flags are validated via --help output instead
        it("--help shows volume and rate flags", async () => {
            const r = await runTool(["say", "--help"]);
            expect(r.stdout).toContain("--volume");
            expect(r.stdout).toContain("--rate");
        });
    });
});

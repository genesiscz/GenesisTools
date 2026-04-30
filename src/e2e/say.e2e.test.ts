import { afterAll, describe, expect, it } from "bun:test";
import { getOutput, runTool } from "@app/utils/e2e/helpers";

describe("tools say", () => {
    afterAll(async () => {
        // Restore default + e2e-test profiles to unmuted state.
        await runTool(["say", "--unmute", "--save", "--app", "default"]);
        await runTool(["say", "--unmute", "--save", "--app", "e2e-test"]);
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

    describe("mute requires --save", () => {
        it("--mute without --save exits 1", async () => {
            const r = await runTool(["say", "--mute"]);
            expect(r.exitCode).toBe(1);
            expect(getOutput(r).toLowerCase()).toContain("require --save");
        });

        it("--unmute without --save exits 1", async () => {
            const r = await runTool(["say", "--unmute"]);
            expect(r.exitCode).toBe(1);
            expect(getOutput(r).toLowerCase()).toContain("require --save");
        });
    });

    describe("default-profile mute (silences no-app calls)", () => {
        it("--mute --save --app default exits 0", async () => {
            const r = await runTool(["say", "--mute", "--save", "--app", "default"]);
            expect(r.exitCode).toBe(0);
        });

        it("speech without --app reports muted when default is muted", async () => {
            await runTool(["say", "--mute", "--save", "--app", "default"]);
            const r = await runTool(["say", "should be muted"]);
            expect(r.exitCode).toBe(0);
            expect(getOutput(r).toLowerCase()).toContain("muted");
        });

        it("--unmute --save --app default exits 0", async () => {
            const r = await runTool(["say", "--unmute", "--save", "--app", "default"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("per-app mute", () => {
        it("--mute --save --app e2e-test exits 0", async () => {
            const r = await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
        });

        it("speech with muted app reports muted", async () => {
            await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);
            const r = await runTool(["say", "should be muted", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
            expect(getOutput(r).toLowerCase()).toContain("muted");
        });

        it("--unmute --save --app e2e-test exits 0", async () => {
            const r = await runTool(["say", "--unmute", "--save", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
        });

        it("--unmute --save through a muted profile (PR #157 t3)", async () => {
            // Set the profile to muted first.
            await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);

            // --unmute --save must not be blocked by the existing mute state.
            const r = await runTool(["say", "ping", "--unmute", "--save", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);

            // After unmuting, plain speech should not say "muted".
            const after = await runTool(["say", "should now run", "--app", "e2e-test"]);
            expect(after.exitCode).toBe(0);
            expect(getOutput(after).toLowerCase()).not.toContain("[say] muted");
        });
    });

    describe("speech options", () => {
        // macOS `say` command hangs when spawned from subprocess (no TTY audio context).
        // Flags validated via --help output instead.
        it("--help shows volume and rate flags", async () => {
            const r = await runTool(["say", "--help"]);
            expect(r.stdout).toContain("--volume");
            expect(r.stdout).toContain("--rate");
        });
    });
});

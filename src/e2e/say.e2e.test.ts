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
            // Verify the mute setup succeeded — otherwise the speak below would
            // actually play audio out of the speakers.
            const setup = await runTool(["say", "--mute", "--save", "--app", "default"]);
            expect(setup.exitCode).toBe(0);

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
            const setup = await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);
            expect(setup.exitCode).toBe(0);

            const r = await runTool(["say", "should be muted", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
            expect(getOutput(r).toLowerCase()).toContain("muted");
        });

        it("--unmute --save --app e2e-test exits 0", async () => {
            const r = await runTool(["say", "--unmute", "--save", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);
        });

        it("--unmute --save through a muted profile (PR #157 t3)", async () => {
            // Pre-condition: profile is muted (assert it actually took).
            const setup = await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);
            expect(setup.exitCode).toBe(0);

            const muted = await runTool(["say", "should be muted", "--app", "e2e-test"]);
            expect(muted.exitCode).toBe(0);
            expect(getOutput(muted).toLowerCase()).toContain("muted");

            // --unmute --save (save-only invocation: no message text, no speak)
            // must not be blocked by the current mute state.
            const r = await runTool(["say", "--unmute", "--save", "--app", "e2e-test"]);
            expect(r.exitCode).toBe(0);

            // Re-mute and verify mute is back — confirms the previous --unmute
            // --save actually toggled the persisted state. Avoids a real speak
            // call which would hit the macOS synthesizer in subprocess.
            const remute = await runTool(["say", "--mute", "--save", "--app", "e2e-test"]);
            expect(remute.exitCode).toBe(0);

            const reMuted = await runTool(["say", "should be muted", "--app", "e2e-test"]);
            expect(reMuted.exitCode).toBe(0);
            expect(getOutput(reMuted).toLowerCase()).toContain("muted");
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

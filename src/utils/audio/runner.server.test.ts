import { describe, expect, it } from "bun:test";
import { BUNDLED_SOUNDS } from "./assets/manifest";
import { resolveSoundBuffer, Sounds } from "./runner.server";

describe("resolveSoundBuffer", () => {
    it("returns a WAV buffer for a synthetic preset", () => {
        const buf = resolveSoundBuffer({ kind: "synth", preset: "blip" });
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    });

    it("returns a buffer for a bundled asset", () => {
        const buf = resolveSoundBuffer({ kind: "bundled", name: "switch.wav" });
        expect(buf.length).toBeGreaterThan(0);
        expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    });

    it("every Sounds enum value is a real bundled asset (RIFF) and in the manifest", () => {
        for (const name of Object.values(Sounds)) {
            expect(BUNDLED_SOUNDS).toContain(name);
            const buf = resolveSoundBuffer({ kind: "bundled", name });
            expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
        }
    });
});

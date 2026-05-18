import { describe, expect, it } from "bun:test";
import { BUNDLED_SOUNDS } from "./assets/manifest";
import { formatAudioLibrary, getAudioLibrary, parseSoundSpec } from "./library";
import { resolveSoundBuffer } from "./runner.server";

describe("getAudioLibrary", () => {
    it("catalogs every bundled + synth sound with one usable default", () => {
        const lib = getAudioLibrary();
        expect(lib.bundled.length).toBe(BUNDLED_SOUNDS.length);
        expect(lib.synth.length).toBeGreaterThan(0);
        expect(lib.default.isDefault).toBe(true);
        expect(lib.default.id).toBe("bundled:switch.wav");
        expect(lib.bundled.filter((e) => e.isDefault).length).toBe(1);

        for (const e of lib.bundled) {
            expect(e.id.startsWith("bundled:")).toBe(true);
            expect(resolveSoundBuffer(e.choice).subarray(0, 4).toString("ascii")).toBe("RIFF");
        }

        for (const e of lib.synth) {
            expect(e.id.startsWith("synth:")).toBe(true);
            expect(resolveSoundBuffer(e.choice).subarray(0, 4).toString("ascii")).toBe("RIFF");
        }
    });
});

describe("parseSoundSpec", () => {
    it("accepts off / valid bundled / valid synth / bare preset", () => {
        expect(parseSoundSpec("off")).toEqual({ ok: true, enabled: false });
        expect(parseSoundSpec("bundled:switch.wav")).toEqual({
            ok: true,
            sound: { kind: "bundled", name: "switch.wav" },
            enabled: true,
        });
        expect(parseSoundSpec("synth:blip")).toEqual({
            ok: true,
            sound: { kind: "synth", preset: "blip" },
            enabled: true,
        });
        expect(parseSoundSpec("soft-chime")).toEqual({
            ok: true,
            sound: { kind: "synth", preset: "soft-chime" },
            enabled: true,
        });
    });

    it("rejects unknown bundled / synth / garbage with an error message", () => {
        expect(parseSoundSpec("bundled:nope.wav")).toEqual({
            ok: false,
            error: "unknown bundled sound: 'nope.wav'",
        });
        expect(parseSoundSpec("synth:nope")).toEqual({ ok: false, error: "unknown synth preset: 'nope'" });
        expect(parseSoundSpec("garbage")).toEqual({ ok: false, error: "unrecognized sound spec: 'garbage'" });
        expect(parseSoundSpec("custom:/no/such/file.wav")).toEqual({
            ok: false,
            error: "custom sound file not found: '/no/such/file.wav'",
        });
    });
});

describe("formatAudioLibrary", () => {
    it("lists bundled + synth with the default marked", () => {
        const txt = formatAudioLibrary();
        expect(txt).toContain("Bundled (Kenney CC0):");
        expect(txt).toContain("bundled:switch.wav  (default)");
        expect(txt).toContain("Synth presets:");
        expect(txt).toContain("synth:soft-chime");
        expect(txt).toContain("custom:/abs/path.wav");
    });
});

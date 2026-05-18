import { describe, expect, it } from "bun:test";
import { DING_PRESETS, renderPresetWav } from "./ding-presets";

describe("ding presets", () => {
    it("exposes the named presets", () => {
        expect(Object.keys(DING_PRESETS).sort()).toEqual(["blip", "knock", "soft-chime", "subtle-bell"]);
    });

    it("renders a deterministic non-empty 16-bit PCM WAV", () => {
        const a = renderPresetWav("soft-chime");
        const b = renderPresetWav("soft-chime");
        expect(a.length).toBeGreaterThan(44);
        expect(a.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(Buffer.compare(a, b)).toBe(0);
    });

    it("falls back to soft-chime for an unknown preset name", () => {
        expect(Buffer.compare(renderPresetWav("nope"), renderPresetWav("soft-chime"))).toBe(0);
    });
});

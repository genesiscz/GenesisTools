import { describe, expect, it } from "bun:test";
import { normalizeSpeakerLabel } from "./speaker-label";

describe("normalizeSpeakerLabel", () => {
    it("uppercases sherpa lowercase labels", () => {
        expect(normalizeSpeakerLabel("speaker_00")).toBe("SPEAKER_00");
    });

    it("zero-pads bare integer/string speaker ids", () => {
        expect(normalizeSpeakerLabel(0)).toBe("SPEAKER_00");
        expect(normalizeSpeakerLabel(3)).toBe("SPEAKER_03");
        expect(normalizeSpeakerLabel("1")).toBe("SPEAKER_01");
    });

    it("passes through already-correct labels", () => {
        expect(normalizeSpeakerLabel("SPEAKER_02")).toBe("SPEAKER_02");
    });

    it("returns undefined for null/undefined/empty", () => {
        expect(normalizeSpeakerLabel(undefined)).toBeUndefined();
        expect(normalizeSpeakerLabel(null)).toBeUndefined();
        expect(normalizeSpeakerLabel("")).toBeUndefined();
    });

    it("rejects invalid numeric ids (negative, non-integer, NaN, Infinity)", () => {
        expect(normalizeSpeakerLabel(-1)).toBeUndefined();
        expect(normalizeSpeakerLabel(1.5)).toBeUndefined();
        expect(normalizeSpeakerLabel(Number.NaN)).toBeUndefined();
        expect(normalizeSpeakerLabel(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});

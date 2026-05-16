import { describe, expect, it } from "bun:test";
import { parseSrt, scoreAgainstReference } from "./verify-against-reference";

describe("parseSrt", () => {
    it("parses cue index, times, speaker prefix and text", () => {
        const srt = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj světe.\n";
        const cues = parseSrt(srt);
        expect(cues).toHaveLength(1);
        expect(cues[0]).toEqual({ start: 0, end: 2, speaker: "SPEAKER_00", text: "Ahoj světe." });
    });

    it("parses a cue with no speaker prefix", () => {
        const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,500\nAhoj.\n");
        expect(cues[0]).toEqual({ start: 1, end: 2.5, speaker: undefined, text: "Ahoj." });
    });
});

describe("scoreAgainstReference", () => {
    it("perfect match → werProxy 0, speakerAgreement 1", () => {
        const a = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj.\n";
        const s = scoreAgainstReference(a, a);
        expect(s.werProxy).toBe(0);
        expect(s.speakerAgreement).toBe(1);
    });

    it("counts speaker disagreement only over cues with speaker in both", () => {
        const cand = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_01: Ahoj.\n";
        const ref = "1\n00:00:00,000 --> 00:00:02,000\nSPEAKER_00: Ahoj.\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(0);
        expect(s.werProxy).toBe(0);
    });

    it("matches short candidate cues to a long reference cue by overlap (no start-distance gate)", () => {
        const ref = "1\n00:00:00,000 --> 00:00:30,000\nSPEAKER_00: Dobrý den jak se máte.\n";
        const cand = "1\n00:00:20,000 --> 00:00:22,000\nSPEAKER_00: máte\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(1);
    });
});

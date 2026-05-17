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

    it("speakerAgreement is permutation-invariant (swapped labels still score 1)", () => {
        const cand =
            "1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: A\n\n" + "2\n00:00:01,000 --> 00:00:02,000\nSPEAKER_01: B\n";
        const ref =
            "1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_01: A\n\n" + "2\n00:00:01,000 --> 00:00:02,000\nSPEAKER_00: B\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(1);
        expect(s.werProxy).toBe(0);
    });

    it("genuinely inconsistent labeling cannot be rescued by any permutation", () => {
        // cand says one speaker for both cues; ref says two different ones —
        // no bijection makes both agree, so the best is 0.5.
        const cand =
            "1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: a\n\n" + "2\n00:00:01,000 --> 00:00:02,000\nSPEAKER_00: b\n";
        const ref =
            "1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: a\n\n" + "2\n00:00:01,000 --> 00:00:02,000\nSPEAKER_01: b\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(0.5);
        expect(s.werProxy).toBe(0);
    });

    it("werProxy is invariant to candidate cue granularity (1 long == 5 short)", () => {
        const ref = "1\n00:00:00,000 --> 00:00:05,000\nSPEAKER_00: jedna dva tři čtyři pět\n";
        const long = "1\n00:00:00,000 --> 00:00:05,000\nSPEAKER_00: jedna dva tři čtyři pět\n";
        const short =
            "1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: jedna\n\n" +
            "2\n00:00:01,000 --> 00:00:02,000\nSPEAKER_00: dva\n\n" +
            "3\n00:00:02,000 --> 00:00:03,000\nSPEAKER_00: tři\n\n" +
            "4\n00:00:03,000 --> 00:00:04,000\nSPEAKER_00: čtyři\n\n" +
            "5\n00:00:04,000 --> 00:00:05,000\nSPEAKER_00: pět\n";
        const sLong = scoreAgainstReference(long, ref);
        const sShort = scoreAgainstReference(short, ref);
        expect(sShort.werProxy).toBe(sLong.werProxy);
        expect(sShort.werProxy).toBe(0);
    });

    it("matches short candidate cues to a long reference cue by overlap (no start-distance gate)", () => {
        const ref = "1\n00:00:00,000 --> 00:00:30,000\nSPEAKER_00: Dobrý den jak se máte.\n";
        const cand = "1\n00:00:20,000 --> 00:00:22,000\nSPEAKER_00: máte\n";
        const s = scoreAgainstReference(cand, ref);
        expect(s.speakerAgreement).toBe(1);
    });
});

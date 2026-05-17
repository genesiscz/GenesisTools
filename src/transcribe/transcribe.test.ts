import { describe, expect, it } from "bun:test";
import type { TranscriptionResult } from "@app/utils/ai/types";
import { formatOutput, formatTimestamp, toSRT, toVTT } from "./index";

describe("formatTimestamp", () => {
    it("formats zero with comma separator", () => {
        expect(formatTimestamp(0, ",")).toBe("00:00:00,000");
    });

    it("formats zero with dot separator", () => {
        expect(formatTimestamp(0, ".")).toBe("00:00:00.000");
    });

    it("formats fractional seconds", () => {
        expect(formatTimestamp(1.5, ".")).toBe("00:00:01.500");
    });

    it("formats minutes and hours", () => {
        expect(formatTimestamp(3661.123, ",")).toBe("01:01:01,123");
    });

    it("handles edge case near rounding", () => {
        expect(formatTimestamp(59.999, ".")).toBe("00:00:59.999");
    });
});

describe("toSRT", () => {
    it("returns plain text when no segments", () => {
        const result: TranscriptionResult = { text: "Hello world" };
        expect(toSRT(result)).toBe("Hello world");
    });

    it("keeps sentence-level segments as separate numbered cues", () => {
        const result: TranscriptionResult = {
            text: "Hello there. Second one.",
            segments: [
                { text: "Hello there.", start: 0, end: 1.5 },
                { text: "Second one.", start: 2.0, end: 3.5 },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello there.");
        expect(srt).toContain("2\n00:00:02,000 --> 00:00:03,500\nSecond one.");
    });

    it("coalesces word-level segments into readable cues split on sentence punctuation", () => {
        const result: TranscriptionResult = {
            text: "dobrý den. jak se máš?",
            segments: [
                { text: "dobrý", start: 0, end: 0.4 },
                { text: "den.", start: 0.4, end: 0.9 },
                { text: "jak", start: 1.0, end: 1.2 },
                { text: "se", start: 1.2, end: 1.4 },
                { text: "máš?", start: 1.4, end: 1.8 },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("1\n00:00:00,000 --> 00:00:00,900\ndobrý den.");
        expect(srt).toContain("2\n00:00:01,000 --> 00:00:01,800\njak se máš?");
    });
});

describe("toVTT", () => {
    it("returns WEBVTT header with plain text when no segments", () => {
        const result: TranscriptionResult = { text: "Hello world" };
        expect(toVTT(result)).toBe("WEBVTT\n\nHello world");
    });

    it("formats cues with dot separator", () => {
        const result: TranscriptionResult = {
            text: "Hello",
            segments: [{ text: "Hello", start: 0, end: 1.5 }],
        };
        const vtt = toVTT(result);
        expect(vtt).toStartWith("WEBVTT");
        expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
    });
});

describe("speaker-aware rendering", () => {
    it("never merges cues across a speaker change and prefixes SRT with SPEAKER", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [
                { text: "Dobrý den.", start: 0, end: 1, speaker: "SPEAKER_00" },
                { text: "Zdravím.", start: 1.1, end: 2, speaker: "SPEAKER_01" },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nSPEAKER_00: Dobrý den.");
        expect(srt).toContain("2\n00:00:01,100 --> 00:00:02,000\nSPEAKER_01: Zdravím.");
    });

    it("does not merge same-speaker fragments across a speaker boundary", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [
                { text: "ano", start: 0, end: 0.5, speaker: "SPEAKER_00" },
                { text: "ne", start: 0.6, end: 1.0, speaker: "SPEAKER_01" },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("SPEAKER_00: ano");
        expect(srt).toContain("SPEAKER_01: ne");
    });

    it("VTT uses <v SPEAKER_NN> voice spans", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [{ text: "Ahoj.", start: 0, end: 1, speaker: "SPEAKER_00" }],
        };
        expect(toVTT(result)).toContain("<v SPEAKER_00>Ahoj.");
    });

    it("text format prefixes each speaker turn", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [
                { text: "A.", start: 0, end: 1, speaker: "SPEAKER_00" },
                { text: "B.", start: 1, end: 2, speaker: "SPEAKER_01" },
            ],
        };
        expect(formatOutput(result, "text")).toBe("SPEAKER_00: A.\nSPEAKER_01: B.");
    });

    it("merges same-speaker cues across a long silence (diarized: no 6s split)", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [
                { text: "Začátek věty", start: 0, end: 2, speaker: "SPEAKER_00" },
                { text: "a pokračování po pauze.", start: 9, end: 11, speaker: "SPEAKER_00" },
            ],
        };
        expect(toSRT(result)).toBe(
            "1\n00:00:00,000 --> 00:00:11,000\nSPEAKER_00: Začátek věty a pokračování po pauze.",
        );
    });

    it("still splits non-diarized cues on the 6s gap", () => {
        const result: TranscriptionResult = {
            text: "x",
            segments: [
                { text: "first part", start: 0, end: 2 },
                { text: "after long gap.", start: 9, end: 11 },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("1\n00:00:00,000 --> 00:00:02,000\nfirst part");
        expect(srt).toContain("2\n00:00:09,000 --> 00:00:11,000\nafter long gap.");
    });

    it("text format unchanged when no segment has a speaker", () => {
        const result: TranscriptionResult = {
            text: "plain transcript",
            segments: [{ text: "plain transcript", start: 0, end: 1 }],
        };
        expect(formatOutput(result, "text")).toBe("plain transcript");
    });
});

import { describe, expect, it } from "bun:test";
import type { TranscriptionResult } from "@app/utils/ai/types";
import { formatTimestamp, toSRT, toVTT } from "./index";

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

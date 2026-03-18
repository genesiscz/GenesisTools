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

    it("formats multiple segments with SRT numbering", () => {
        const result: TranscriptionResult = {
            text: "Hello Second",
            segments: [
                { text: "Hello", start: 0, end: 1.5 },
                { text: "Second", start: 2.0, end: 3.5 },
            ],
        };
        const srt = toSRT(result);
        expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello");
        expect(srt).toContain("2\n00:00:02,000 --> 00:00:03,500\nSecond");
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

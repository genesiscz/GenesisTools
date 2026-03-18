import { describe, expect, it } from "bun:test";
import { type CaptionSegment, extractVideoId, formatTimestamp, toSRT, toVTT } from "./transcribe";

describe("extractVideoId", () => {
    it("extracts from standard watch URL", () => {
        expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from short URL", () => {
        expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from embed URL", () => {
        expect(extractVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from shorts URL", () => {
        expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts bare video ID", () => {
        expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("returns null for invalid input", () => {
        expect(extractVideoId("not-a-valid-video")).toBeNull();
        expect(extractVideoId("")).toBeNull();
        expect(extractVideoId("https://example.com")).toBeNull();
    });

    it("handles URL with extra params", () => {
        expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
    });
});

describe("formatTimestamp", () => {
    it("formats zero", () => {
        expect(formatTimestamp(0)).toBe("00:00:00.000");
    });

    it("formats fractional seconds", () => {
        expect(formatTimestamp(1.5)).toBe("00:00:01.500");
    });

    it("formats minutes", () => {
        expect(formatTimestamp(90)).toBe("00:01:30.000");
    });

    it("formats hours", () => {
        expect(formatTimestamp(3661.123)).toBe("01:01:01.123");
    });

    it("formats large values", () => {
        expect(formatTimestamp(7200)).toBe("02:00:00.000");
    });

    it("carries millisecond overflow into the next second", () => {
        expect(formatTimestamp(59.9995)).toBe("00:01:00.000");
    });
});

describe("toSRT", () => {
    const segments: CaptionSegment[] = [
        { text: "Hello world", start: 0, end: 1.5 },
        { text: "Second line", start: 2.0, end: 3.5 },
    ];

    it("formats segments with comma separator and index numbering", () => {
        const result = toSRT(segments);
        expect(result).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello world");
        expect(result).toContain("2\n00:00:02,000 --> 00:00:03,500\nSecond line");
    });

    it("uses commas for millisecond separator (SRT spec)", () => {
        const result = toSRT(segments);
        expect(result).toContain(",");
        expect(result).not.toContain(".");
    });
});

describe("toVTT", () => {
    const segments: CaptionSegment[] = [{ text: "Hello world", start: 0, end: 1.5 }];

    it("includes WEBVTT header", () => {
        const result = toVTT(segments);
        expect(result).toStartWith("WEBVTT");
    });

    it("uses dot separator (VTT spec)", () => {
        const result = toVTT(segments);
        expect(result).toContain("00:00:00.000 --> 00:00:01.500");
    });
});

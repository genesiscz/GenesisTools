import { describe, expect, it } from "bun:test";
import { compactTranscript, isNoiseSegment } from "@app/youtube/lib/transcript-compact";
import type { Transcript } from "@app/youtube/lib/types";

function makeTranscript(segments: Array<{ text: string; start: number; end: number }>): Transcript {
    return {
        id: 1,
        videoId: "vid00000001",
        lang: "en",
        source: "captions",
        text: segments.map((segment) => segment.text).join(" "),
        segments,
        durationSec: segments.at(-1)?.end ?? null,
        createdAt: "2026-04-27T00:00:00.000Z",
    };
}

describe("isNoiseSegment", () => {
    it("flags pure caption annotations", () => {
        expect(isNoiseSegment("[music]")).toBe(true);
        expect(isNoiseSegment(" [Applause] ")).toBe(true);
        expect(isNoiseSegment("[Laughter]")).toBe(true);
        expect(isNoiseSegment("[noise]")).toBe(true);
        expect(isNoiseSegment("[inaudible]")).toBe(true);
    });

    it("does not flag real text that happens to contain a bracket tag", () => {
        expect(isNoiseSegment("[music] welcome back everyone")).toBe(false);
        expect(isNoiseSegment("hey what's up")).toBe(false);
    });
});

describe("compactTranscript", () => {
    it("strips inline bracket annotations from segment text", () => {
        const transcript = makeTranscript([
            { text: "[music] welcome back everyone", start: 0, end: 2 },
            { text: "today we are testing GPT 5.5", start: 2.5, end: 5 },
        ]);
        const compact = compactTranscript(transcript);

        expect(compact.segments[0].text).toBe("welcome back everyone");
        expect(compact.segments[1].text).toBe("today we are testing GPT 5.5");
    });

    it("drops segments that are pure noise after stripping", () => {
        const transcript = makeTranscript([
            { text: "[music]", start: 0, end: 1 },
            { text: "first real line", start: 1, end: 3 },
            { text: "[applause]", start: 3, end: 4 },
            { text: "second real line", start: 4, end: 6 },
        ]);
        const compact = compactTranscript(transcript);

        expect(compact.segments.map((segment) => segment.text)).toEqual(["first real line", "second real line"]);
    });

    it("dedups segments whose text is a substring of the prior segment", () => {
        const transcript = makeTranscript([
            { text: "open six more codex agents", start: 23, end: 28 },
            { text: "open six more codex", start: 25, end: 27 },
            { text: "agents to do work", start: 27, end: 30 },
        ]);
        const compact = compactTranscript(transcript);

        expect(compact.segments.map((segment) => segment.text)).toEqual([
            "open six more codex agents",
            "agents to do work",
        ]);
    });

    it("merges consecutive segments at sentence boundaries", () => {
        const transcript = makeTranscript([
            { text: "I now want you to prompt each", start: 37, end: 41 },
            { text: "agent to do an in-depth review of the", start: 41, end: 45 },
            { text: "project and prepare to assist me.", start: 45, end: 48 },
            { text: "Let's go chat.", start: 48, end: 50 },
        ]);
        const compact = compactTranscript(transcript, { mergeSentences: true });

        expect(compact.segments).toHaveLength(2);
        expect(compact.segments[0].text).toBe(
            "I now want you to prompt each agent to do an in-depth review of the project and prepare to assist me."
        );
        expect(compact.segments[0].start).toBe(37);
        expect(compact.segments[0].end).toBe(48);
        expect(compact.segments[1].text).toBe("Let's go chat.");
    });

    it("time-buckets when bucketSec is set", () => {
        const transcript = makeTranscript([
            { text: "alpha.", start: 0, end: 5 },
            { text: "bravo.", start: 5, end: 25 },
            { text: "charlie.", start: 25, end: 35 },
            { text: "delta.", start: 35, end: 45 },
            { text: "echo.", start: 45, end: 65 },
        ]);
        const compact = compactTranscript(transcript, { bucketSec: 30 });

        expect(compact.segments).toHaveLength(3);
        expect(compact.segments[0]).toMatchObject({ start: 0, end: 25, text: "alpha. bravo." });
        expect(compact.segments[1]).toMatchObject({ start: 25, end: 45, text: "charlie. delta." });
        expect(compact.segments[2]).toMatchObject({ start: 45, end: 65, text: "echo." });
    });

    it("rebuilds the top-level `text` field from compacted segments", () => {
        const transcript = makeTranscript([
            { text: "[music]", start: 0, end: 1 },
            { text: "hello world", start: 1, end: 3 },
            { text: "hello world", start: 2, end: 3 },
            { text: "goodbye world", start: 3, end: 5 },
        ]);
        const compact = compactTranscript(transcript);

        expect(compact.text).toBe("hello world goodbye world");
    });

    it("preserves the videoId, lang, source, and durationSec fields", () => {
        const transcript = makeTranscript([
            { text: "first", start: 0, end: 1 },
            { text: "second", start: 1, end: 2 },
        ]);
        const compact = compactTranscript(transcript);

        expect(compact.videoId).toBe("vid00000001");
        expect(compact.lang).toBe("en");
        expect(compact.source).toBe("captions");
        expect(compact.durationSec).toBe(2);
    });

    it("returns the same shape when no transformation applies", () => {
        const transcript = makeTranscript([{ text: "lonely sentence.", start: 0, end: 5 }]);
        const compact = compactTranscript(transcript);

        expect(compact.segments).toEqual([{ text: "lonely sentence.", start: 0, end: 5 }]);
        expect(compact.text).toBe("lonely sentence.");
    });
});

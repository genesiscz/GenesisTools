import { describe, expect, test } from "bun:test";
import { segmentsToParagraphs } from "@app/utils/ui/components/youtube/transcript-paragraphs";

describe("segmentsToParagraphs speaker boundaries", () => {
    test("caption segments (no speakers) group exactly as before", () => {
        const paragraphs = segmentsToParagraphs([
            { text: "one.", start: 0, end: 5 },
            { text: "two.", start: 5, end: 10 },
            { text: "three.", start: 10, end: 15 },
        ]);

        expect(paragraphs).toEqual([{ text: "one. two. three.", start: 0, end: 15 }]);
    });

    test("speaker change is a hard boundary and paragraphs carry the speaker", () => {
        const paragraphs = segmentsToParagraphs([
            { text: "hello there.", start: 0, end: 4, speaker: 0 },
            { text: "still me talking.", start: 4, end: 8, speaker: 0 },
            { text: "hi, other voice.", start: 8, end: 12, speaker: 1 },
            { text: "back again.", start: 12, end: 16, speaker: 0 },
        ]);

        expect(paragraphs).toEqual([
            { text: "hello there. still me talking.", start: 0, end: 8, speaker: 0 },
            { text: "hi, other voice.", start: 8, end: 12, speaker: 1 },
            { text: "back again.", start: 12, end: 16, speaker: 0 },
        ]);
    });

    test("short orphans are not absorbed across a speaker boundary", () => {
        const paragraphs = segmentsToParagraphs([
            { text: "short a.", start: 0, end: 2, speaker: 0 },
            { text: "short b.", start: 2, end: 4, speaker: 1 },
        ]);

        expect(paragraphs).toEqual([
            { text: "short a.", start: 0, end: 2, speaker: 0 },
            { text: "short b.", start: 2, end: 4, speaker: 1 },
        ]);
    });

    test("segments without speaker never split an ongoing block", () => {
        const paragraphs = segmentsToParagraphs([
            { text: "a.", start: 0, end: 2, speaker: 0 },
            { text: "b.", start: 2, end: 4 },
            { text: "c.", start: 4, end: 6, speaker: 0 },
        ]);

        expect(paragraphs).toEqual([{ text: "a. b. c.", start: 0, end: 6, speaker: 0 }]);
    });

    test("short orphan is not absorbed back across a hard-gap boundary", () => {
        const paragraphs = segmentsToParagraphs([
            { text: "Intro line.", start: 0, end: 1 },
            { text: "Tail.", start: 3, end: 3.5 },
        ]);

        expect(paragraphs).toEqual([
            { text: "Intro line.", start: 0, end: 1 },
            { text: "Tail.", start: 3, end: 3.5 },
        ]);
    });
});

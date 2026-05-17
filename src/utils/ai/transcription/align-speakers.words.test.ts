import { describe, expect, it } from "bun:test";
import { assignSpeakersByWords } from "./align-speakers";

describe("assignSpeakersByWords", () => {
    it("re-segments a segment at a mid-segment speaker change", () => {
        const seg = { text: "ano jasně ne nikdy", start: 0, end: 4 };
        const words = [
            { word: "ano", start: 0.0, end: 0.5 },
            { word: "jasně", start: 0.5, end: 1.0 },
            { word: "ne", start: 2.0, end: 2.3 },
            { word: "nikdy", start: 2.3, end: 3.0 },
        ];
        const turns = [
            { start: 0, end: 1.2, speaker: "speaker_00" },
            { start: 1.2, end: 4, speaker: "speaker_01" },
        ];
        expect(assignSpeakersByWords(seg, words, turns)).toEqual([
            { text: "ano jasně", start: 0.0, end: 1.0, speaker: "SPEAKER_00" },
            { text: "ne nikdy", start: 2.0, end: 3.0, speaker: "SPEAKER_01" },
        ]);
    });

    it("returns the segment unchanged (single speaker) when no mid-segment change", () => {
        const seg = { text: "ano ne", start: 0, end: 2 };
        const words = [
            { word: "ano", start: 0, end: 1 },
            { word: "ne", start: 1, end: 2 },
        ];
        const turns = [{ start: 0, end: 5, speaker: "speaker_00" }];
        expect(assignSpeakersByWords(seg, words, turns)).toEqual([
            { text: "ano ne", start: 0, end: 2, speaker: "SPEAKER_00" },
        ]);
    });
});

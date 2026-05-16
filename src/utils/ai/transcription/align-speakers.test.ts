import { describe, expect, it } from "bun:test";
import { assignSpeakers } from "./align-speakers";

const turns = [
    { start: 0, end: 5, speaker: "speaker_00" },
    { start: 5, end: 10, speaker: "speaker_01" },
];

describe("assignSpeakers", () => {
    it("assigns max-overlap speaker, normalized", () => {
        const segs = [
            { text: "A", start: 0.5, end: 4 },
            { text: "B", start: 6, end: 9 },
        ];
        expect(assignSpeakers(segs, turns)).toEqual([
            { text: "A", start: 0.5, end: 4, speaker: "SPEAKER_00" },
            { text: "B", start: 6, end: 9, speaker: "SPEAKER_01" },
        ]);
    });

    it("fillNearest=true labels a zero-overlap segment with nearest turn", () => {
        const segs = [{ text: "C", start: 20, end: 21 }];
        expect(assignSpeakers(segs, turns)[0].speaker).toBe("SPEAKER_01");
    });

    it("sums overlap per speaker then picks the dominant", () => {
        const segs = [{ text: "D", start: 4, end: 8 }]; // 1s spk0, 3s spk1
        expect(assignSpeakers(segs, turns)[0].speaker).toBe("SPEAKER_01");
    });
});

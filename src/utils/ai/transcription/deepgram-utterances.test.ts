import { describe, expect, it } from "bun:test";
import { deepgramUtteranceSegments } from "./TranscriptionManager";

describe("deepgramUtteranceSegments", () => {
    it("maps raw utterances to speaker-labelled segments", () => {
        const result = {
            responses: [
                {
                    body: {
                        results: {
                            utterances: [
                                { speaker: 0, transcript: "Dobrý den.", start: 0.1, end: 1.2 },
                                { speaker: 1, transcript: "Zdravím.", start: 1.5, end: 2.0 },
                            ],
                        },
                    },
                },
            ],
        };
        expect(deepgramUtteranceSegments(result)).toEqual([
            { text: "Dobrý den.", start: 0.1, end: 1.2, speaker: "SPEAKER_00" },
            { text: "Zdravím.", start: 1.5, end: 2.0, speaker: "SPEAKER_01" },
        ]);
    });
    it("returns undefined when no utterances present", () => {
        expect(deepgramUtteranceSegments({ responses: [{ body: {} }] })).toBeUndefined();
        expect(deepgramUtteranceSegments({})).toBeUndefined();
    });
});

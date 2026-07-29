import { describe, expect, it } from "bun:test";
import { parseExportJson } from "@app/youtube/lib/transcript-export";
import { SafeJSON } from "@genesiscz/utils/json";

function exportJson(segments: unknown): string {
    return SafeJSON.stringify({ videoId: "abc123def45", text: "alpha beta", segments }, { strict: true });
}

describe("parseExportJson segment validation", () => {
    it("keeps well-formed segments, with and without a speaker", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "alpha", start: 0, end: 10 },
                { text: "beta", start: 10, end: 20, speaker: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([
            { text: "alpha", start: 0, end: 10 },
            { text: "beta", start: 10, end: 20, speaker: 1 },
        ]);
    });

    // Each of these used to be cast straight into TranscriptSegment[] and written to
    // the DB by saveTranscript, surfacing much later as broken chunking or rendering.
    it("drops entries that are not segment objects", () => {
        const parsed = parseExportJson(exportJson([null, "alpha", 42, [], { text: "ok", start: 0, end: 1 }]));

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    it("drops non-string text and non-finite or non-numeric times", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: 7, start: 0, end: 1 },
                { text: "a", start: "0", end: 1 },
                { text: "b", start: 0, end: Number.NaN },
                { text: "c", start: 0 },
                { text: "ok", start: 0, end: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    it("drops negative and reversed ranges", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "negative", start: -5, end: 10 },
                { text: "reversed", start: 20, end: 10 },
                { text: "ok", start: 0, end: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    // `speaker` is a 0-based index, so a negative or fractional value has no speaker
    // to name — it would key a label lookup that can never match.
    it("drops negative, fractional and non-numeric speaker indices", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "negative", start: 0, end: 1, speaker: -1 },
                { text: "fractional", start: 0, end: 1, speaker: 1.5 },
                { text: "string", start: 0, end: 1, speaker: "0" },
                { text: "ok", start: 0, end: 1, speaker: 0 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1, speaker: 0 }]);
    });

    it("treats a zero-length segment as valid and a non-array as empty", () => {
        expect(parseExportJson(exportJson([{ text: "tick", start: 5, end: 5 }]))?.segments).toHaveLength(1);
        expect(parseExportJson(exportJson("nope"))?.segments).toEqual([]);
        expect(parseExportJson(exportJson(undefined))?.segments).toEqual([]);
    });
});

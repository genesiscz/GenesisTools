import { describe, expect, it } from "bun:test";
import type { TranscriptionSegment } from "@app/utils/ai/types";
import { cleanRepetitions } from "./repetition-cleanup";

describe("cleanRepetitions", () => {
    it("collapses a single-token loop (run >= 5) to one", () => {
        const r = cleanRepetitions({ text: "ano ještě ještě ještě ještě ještě ještě konec" });
        expect(r.text).toBe("ano ještě konec");
    });

    it("collapses a clause loop (phrase run >= 3) to one", () => {
        const t = "Zkusíme zpátky. Zkusíme zpátky. Zkusíme zpátky. Zkusíme zpátky. Dál.";
        expect(cleanRepetitions({ text: t }).text).toBe("Zkusíme zpátky. Dál.");
    });

    it("preserves scattered legit repeats (interviewer 'Dobře, děkuji.' x3 with content between)", () => {
        const t = "Dobře, děkuji. Otázka jedna. Dobře, děkuji. Otázka dva. Dobře, děkuji. Konec.";
        expect(cleanRepetitions({ text: t }).text).toBe(t);
    });

    it("is Czech-diacritic-insensitive when matching the run", () => {
        const r = cleanRepetitions({ text: "Ještě ještě JEŠTĚ ještě ještě dál" });
        expect(r.text).toBe("Ještě dál");
    });

    it("is idempotent", () => {
        const once = cleanRepetitions({ text: "a a a a a a b" });
        const twice = cleanRepetitions(once);
        expect(twice).toEqual(once);
    });

    it("dedups a segment equal to the previous within < 2s gap and absorbs its end", () => {
        const segments: TranscriptionSegment[] = [
            { text: "Dobrý den.", start: 0, end: 1 },
            { text: "dobrý den", start: 1.5, end: 2.4 },
            { text: "Jak se máte?", start: 5, end: 6 },
        ];
        const r = cleanRepetitions({ text: "x", segments });
        expect(r.segments).toEqual([
            { text: "Dobrý den.", start: 0, end: 2.4 },
            { text: "Jak se máte?", start: 5, end: 6 },
        ]);
    });

    it("does NOT cross-segment-dedup identical text from different speakers within < 2s gap", () => {
        const segments: TranscriptionSegment[] = [
            { text: "Dobrý den.", start: 0, end: 1, speaker: "SPEAKER_00" },
            { text: "dobrý den", start: 1.5, end: 2.4, speaker: "SPEAKER_01" },
            { text: "Jak se máte?", start: 5, end: 6, speaker: "SPEAKER_00" },
        ];
        const r = cleanRepetitions({ text: "x", segments });
        expect(r.segments).toEqual([
            { text: "Dobrý den.", start: 0, end: 1, speaker: "SPEAKER_00" },
            { text: "dobrý den", start: 1.5, end: 2.4, speaker: "SPEAKER_01" },
            { text: "Jak se máte?", start: 5, end: 6, speaker: "SPEAKER_00" },
        ]);
    });
});

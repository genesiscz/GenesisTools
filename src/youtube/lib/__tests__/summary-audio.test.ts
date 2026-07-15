import { describe, expect, it } from "bun:test";
import { buildNarrationScript } from "@app/youtube/lib/summary-audio";
import type { VideoLongSummary } from "@app/youtube/lib/video.types";

const BASE_SUMMARY: VideoLongSummary = {
    tldr: "The video covers ARR growth.",
    keyPoints: ["Revenue tripled", "Churn dropped"],
    learnings: ["Focus on retention"],
    chapters: [
        { title: "Intro", summary: "Speaker opens with context.", startSec: 0, endSec: 60 },
        { title: "Growth", summary: "ARR discussion.", startSec: 60, endSec: 120 },
    ],
    conclusion: "Worth watching.",
};

describe("buildNarrationScript", () => {
    it("includes the TL;DR, key points, learnings, chapters, and conclusion", () => {
        const script = buildNarrationScript(BASE_SUMMARY, "long");

        expect(script).toContain("The video covers ARR growth.");
        expect(script).toContain("Revenue tripled");
        expect(script).toContain("Focus on retention");
        expect(script).toContain("Chapter: Intro. Speaker opens with context.");
        expect(script).toContain("Chapter: Growth. ARR discussion.");
        expect(script).toContain("Worth watching.");
    });

    it("strips markdown emphasis and citation markers, producing plain prose", () => {
        const summary: VideoLongSummary = {
            ...BASE_SUMMARY,
            tldr: "The **video** covers `ARR` growth [#1].",
            keyPoints: ["Revenue *tripled* [#2]"],
            learnings: [],
            chapters: [{ title: "# Intro", summary: "See [details](https://example.com) here.", startSec: 0 }],
            conclusion: null,
        };

        const script = buildNarrationScript(summary, "long");

        expect(script).not.toMatch(/[*_`#[\]]/);
        expect(script).toContain("The video covers ARR growth.");
        expect(script).toContain("Revenue tripled");
        expect(script).toContain("See details here.");
    });

    it("skips missing conclusion and empty learnings without leaving artifacts", () => {
        const summary: VideoLongSummary = {
            tldr: "TLDR.",
            keyPoints: ["Point one"],
            learnings: [],
            chapters: [],
            conclusion: null,
        };

        const script = buildNarrationScript(summary, "long");

        expect(script).toBe("TLDR. Key points. Point one.");
        expect(script).not.toContain("What you should take away");
        expect(script).not.toContain("Chapter:");
        expect(script.endsWith(".")).toBe(true);
    });

    it("skips empty key points and chapter summary text gracefully", () => {
        const summary: VideoLongSummary = {
            tldr: "TLDR only.",
            keyPoints: [],
            learnings: [],
            chapters: [{ title: "Bare chapter", summary: "" }],
            conclusion: null,
        };

        const script = buildNarrationScript(summary, "long");

        expect(script).toBe("TLDR only. Chapter: Bare chapter.");
    });
});

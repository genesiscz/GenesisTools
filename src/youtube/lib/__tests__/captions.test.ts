import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fetchCaptions } from "@app/youtube/lib/captions";

const fetchCalls: unknown[] = [];
let transcriptResponses: unknown[][] = [];
let transcriptFailures: Error[] = [];

mock.module("youtube-transcript", () => ({
    YoutubeTranscript: {
        fetchTranscript: async (videoId: string, config?: { lang?: string }) => {
            fetchCalls.push({ videoId, config });
            const failure = transcriptFailures.shift();

            if (failure) {
                throw failure;
            }

            return transcriptResponses.shift() ?? [];
        },
    },
}));

beforeEach(() => {
    fetchCalls.length = 0;
    transcriptResponses = [];
    transcriptFailures = [];
});

describe("fetchCaptions", () => {
    it("returns normalized caption text and segments for the first matching preferred language", async () => {
        transcriptFailures.push(new Error("missing cs"));
        transcriptResponses.push([
            { text: "Hello", offset: 1000, duration: 1500, lang: "en" },
            { text: "world", offset: 2500, duration: 500, lang: "en" },
        ]);

        await expect(fetchCaptions({ videoId: "abc123def45", preferredLangs: ["cs", "en"] })).resolves.toEqual({
            text: "Hello world",
            segments: [
                { text: "Hello", start: 1, end: 2.5 },
                { text: "world", start: 2.5, end: 3 },
            ],
            lang: "en",
        });
        expect(fetchCalls).toEqual([
            { videoId: "abc123def45", config: { lang: "cs" } },
            { videoId: "abc123def45", config: { lang: "en" } },
        ]);
    });

    it("uses the transcript language when no preferred language is provided", async () => {
        transcriptResponses.push([{ text: "Ahoj", offset: 0, duration: 1000, lang: "cs" }]);

        await expect(fetchCaptions({ videoId: "abc123def45" })).resolves.toMatchObject({ lang: "cs", text: "Ahoj" });
        expect(fetchCalls).toEqual([{ videoId: "abc123def45", config: undefined }]);
    });

    it("returns null when all languages fail or return empty transcripts", async () => {
        transcriptFailures.push(new Error("missing cs"));
        transcriptResponses.push([]);

        await expect(fetchCaptions({ videoId: "abc123def45", preferredLangs: ["cs", "en"] })).resolves.toBeNull();
    });
});

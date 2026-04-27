import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { bucketSegments, SummaryService } from "@app/youtube/lib/summarize";

const summarizerCreateCalls: unknown[] = [];
const summarizeCalls: unknown[] = [];
const disposeCalls: unknown[] = [];
const callLlmCalls: unknown[] = [];
let summaries: string[] = [];
let llmResponses: string[] = [];

beforeEach(() => {
    summarizerCreateCalls.length = 0;
    summarizeCalls.length = 0;
    disposeCalls.length = 0;
    callLlmCalls.length = 0;
    summaries = [];
    llmResponses = [];
});

describe("SummaryService", () => {
    it("returns cached short summaries unless forceRecompute is set", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.setVideoSummary("abc123def45", "short", "Cached summary");
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "short" })).resolves.toEqual({ short: "Cached summary" });
            expect(summarizeCalls).toHaveLength(0);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("summarizes transcript text and persists short summary", async () => {
        const { db, config, dir } = await makeFixture();
        const progress: unknown[] = [];

        try {
            await config.update({ provider: { summarize: "openai" } });
            summaries = ["Fresh summary"];
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "short", onProgress: (info) => progress.push(info) })).resolves.toEqual({ short: "Fresh summary" });
            expect(summarizerCreateCalls).toEqual([{ provider: "openai" }]);
            expect(summarizeCalls).toEqual(["First second third fourth"]);
            expect(db.getVideo("abc123def45")?.summaryShort).toBe("Fresh summary");
            expect(disposeCalls).toHaveLength(1);
            expect(progress).toEqual([{ phase: "summarize", message: "summarizing transcript" }]);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("summarizes timestamped output via a single Summarizer call (no providerChoice)", async () => {
        const { db, config, dir } = await makeFixture();
        const progress: unknown[] = [];

        try {
            summaries = [JSON.stringify([
                { startSec: 0, endSec: 10, text: "First half" },
                { startSec: 10, endSec: 20, text: "Second half" },
            ])];
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "timestamped", provider: "groq", onProgress: (info) => progress.push(info) })).resolves.toEqual({
                timestamped: [
                    { startSec: 0, endSec: 10, text: "First half" },
                    { startSec: 10, endSec: 20, text: "Second half" },
                ],
            });
            expect(summarizerCreateCalls).toEqual([{ provider: "groq" }]);
            expect(summarizeCalls).toHaveLength(1);
            expect(db.getVideo("abc123def45")?.summaryTimestamped).toEqual([
                { startSec: 0, endSec: 10, text: "First half" },
                { startSec: 10, endSec: 20, text: "Second half" },
            ]);
            expect(progress).toEqual([{ phase: "summarize", message: "Summarizing entire transcript in one call" }]);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("summarizes timestamped output via callLLM when providerChoice is supplied", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            llmResponses = ["```json\n[{\"startSec\":0,\"endSec\":20,\"text\":\"All of it\"}]\n```"];
            const service = new SummaryService(db, config, makeDeps());

            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<typeof service.summarize>[0]["providerChoice"];
            await expect(service.summarize({ videoId: "abc123def45", mode: "timestamped", providerChoice: fakeChoice })).resolves.toEqual({
                timestamped: [{ startSec: 0, endSec: 20, text: "All of it" }],
            });
            expect(callLlmCalls).toHaveLength(1);
            expect(summarizeCalls).toHaveLength(0);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("falls back to a single bin if the LLM response cannot be parsed as JSON", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            summaries = ["Plain prose, not JSON at all."];
            const service = new SummaryService(db, config, makeDeps());

            const result = await service.summarize({ videoId: "abc123def45", mode: "timestamped" });
            expect(result.timestamped?.length).toBe(1);
            expect(result.timestamped?.[0].text).toContain("Plain prose");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("throws for unknown videos or missing transcripts", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-summary-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });
        const service = new SummaryService(db, config);

        try {
            await expect(service.summarize({ videoId: "missing", mode: "short" })).rejects.toThrow("unknown video: missing");
            db.upsertChannel({ handle: "@mkbhd", title: "MKBHD" });
            db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Video" });
            await expect(service.summarize({ videoId: "abc123def45", mode: "short" })).rejects.toThrow("no transcript for video abc123def45; transcribe first");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("bucketSegments", () => {
    it("uses full transcript text when no segments are present", () => {
        expect(bucketSegments({ id: 1, videoId: "abc123def45", lang: "en", source: "ai", text: "plain text", segments: [], durationSec: 12, createdAt: "now" }, 10)).toEqual([
            { startSec: 0, endSec: 12, text: "plain text" },
        ]);
    });
});

async function makeFixture(): Promise<{ db: YoutubeDatabase; config: YoutubeConfig; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-summary-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd", title: "MKBHD" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Video" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "First second third fourth",
        segments: [
            { text: "First", start: 0, end: 5 },
            { text: "second", start: 5, end: 9 },
            { text: "third", start: 10, end: 15 },
            { text: "fourth", start: 15, end: 19 },
        ],
        durationSec: 20,
    });

    return { db, config, dir };
}

function makeDeps() {
    return {
        createSummarizer: async (opts: unknown) => {
            summarizerCreateCalls.push(opts);

            return {
                summarize: async (text: string) => {
                    summarizeCalls.push(text);

                    return { summary: summaries.shift() ?? `summary:${text}`, originalLength: text.length };
                },
                dispose: () => {
                    disposeCalls.push(true);
                },
            };
        },
        callLLM: async (opts: unknown) => {
            callLlmCalls.push(opts);

            return { content: llmResponses.shift() ?? "[]" };
        },
    };
}

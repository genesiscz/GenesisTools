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
let summaries: string[] = [];

beforeEach(() => {
    summarizerCreateCalls.length = 0;
    summarizeCalls.length = 0;
    disposeCalls.length = 0;
    summaries = [];
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

    it("summarizes timestamped bins and persists them", async () => {
        const { db, config, dir } = await makeFixture();
        const progress: unknown[] = [];

        try {
            summaries = ["Bin one", "Bin two"];
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "timestamped", binSizeSec: 10, provider: "groq", onProgress: (info) => progress.push(info) })).resolves.toEqual({
                timestamped: [
                    { startSec: 0, endSec: 10, text: "Bin one" },
                    { startSec: 10, endSec: 20, text: "Bin two" },
                ],
            });
            expect(summarizerCreateCalls).toEqual([{ provider: "groq" }]);
            expect(summarizeCalls).toEqual(["First second", "third fourth"]);
            expect(db.getVideo("abc123def45")?.summaryTimestamped).toEqual([
                { startSec: 0, endSec: 10, text: "Bin one" },
                { startSec: 10, endSec: 20, text: "Bin two" },
            ]);
            expect(progress).toEqual([
                { phase: "summarize", percent: 0, message: "Summarizing bin 1/2" },
                { phase: "summarize", percent: 0.5, message: "Summarizing bin 2/2" },
            ]);
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
    };
}

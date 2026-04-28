import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { bucketSegments, pickSectionCount, SummaryService } from "@app/youtube/lib/summarize";

const summarizerCreateCalls: unknown[] = [];
const summarizeCalls: unknown[] = [];
const disposeCalls: unknown[] = [];
const callLlmCalls: unknown[] = [];
const callLlmStructuredCalls: unknown[] = [];
let summaries: string[] = [];
let llmResponses: string[] = [];
let structuredResponses: unknown[] = [];

beforeEach(() => {
    summarizerCreateCalls.length = 0;
    summarizeCalls.length = 0;
    disposeCalls.length = 0;
    callLlmCalls.length = 0;
    callLlmStructuredCalls.length = 0;
    summaries = [];
    llmResponses = [];
    structuredResponses = [];
});

describe("pickSectionCount", () => {
    it("returns 1 for ≤3-minute videos", () => {
        expect(pickSectionCount(60)).toBe(1);
        expect(pickSectionCount(180)).toBe(1);
    });

    it("yields ≥1 section per 15 minutes (lower bound)", () => {
        const total = 60 * 60; // 60 min
        const n = pickSectionCount(total);
        expect(n).toBeGreaterThanOrEqual(Math.ceil(total / 900));
    });

    it("respects the 3-minute upper-bound on sections per video", () => {
        const total = 60 * 60; // 60 min
        const n = pickSectionCount(total);
        expect(n).toBeLessThanOrEqual(Math.floor(total / 180));
    });

    it("respects an explicit length=short", () => {
        const total = 11161; // 3:06:01
        expect(pickSectionCount(total, { length: "short" })).toBe(Math.ceil(total / 900));
    });

    it("respects an explicit length=detailed and caps at 30 sections", () => {
        const total = 11161;
        const n = pickSectionCount(total, { length: "detailed" });
        expect(n).toBeLessThanOrEqual(30);
        expect(n).toBeGreaterThanOrEqual(Math.ceil(total / 900));
    });

    it("respects the explicit override", () => {
        expect(pickSectionCount(11161, { override: 7 })).toBe(7);
    });
});

describe("SummaryService", () => {
    it("returns cached short summaries unless forceRecompute is set", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.setVideoSummary("abc123def45", "short", "Cached summary");
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "short" })).resolves.toEqual({
                short: "Cached summary",
            });
            expect(summarizeCalls).toHaveLength(0);
            expect(callLlmStructuredCalls).toHaveLength(0);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("summarizes timestamped via callLLMStructured and persists the result", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            structuredResponses = [
                {
                    tldr: "All-up tldr.",
                    sections: [
                        { startSec: 0, endSec: 360, icon: "🎯", title: "Intro", text: "Speaker introduces the topic." },
                        { startSec: 360, endSec: 720, icon: "💰", title: "ARR moment", text: "ARR hits 128k." },
                    ],
                },
            ];
            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<
                typeof SummaryService.prototype.summarize
            >[0]["providerChoice"];
            const service = new SummaryService(db, config, makeDeps());

            const result = await service.summarize({
                videoId: "abc123def45",
                mode: "timestamped",
                providerChoice: fakeChoice,
                tone: "insightful",
                length: "auto",
            });

            expect(result.timestamped?.length).toBe(2);
            expect(result.timestamped?.[0]).toMatchObject({ icon: "🎯", title: "Intro" });
            expect(callLlmStructuredCalls).toHaveLength(1);
            expect(db.getVideo("abc123def45")?.summaryTimestamped?.length).toBe(2);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("summarizes long via callLLMStructured and persists the structured result", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            structuredResponses = [
                {
                    tldr: "It's all about ARR.",
                    keyPoints: ["one", "two", "three"],
                    learnings: ["a", "b"],
                    chapters: [{ title: "Intro", summary: "Speaker opens." }],
                    conclusion: "Stay consistent.",
                },
            ];
            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<
                typeof SummaryService.prototype.summarize
            >[0]["providerChoice"];
            const service = new SummaryService(db, config, makeDeps());

            const result = await service.summarize({
                videoId: "abc123def45",
                mode: "long",
                providerChoice: fakeChoice,
            });

            expect(result.long?.tldr).toBe("It's all about ARR.");
            expect(result.long?.keyPoints).toHaveLength(3);
            expect(callLlmStructuredCalls).toHaveLength(1);
            expect(db.getVideo("abc123def45")?.summaryLong?.tldr).toBe("It's all about ARR.");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("requires providerChoice for timestamped and long modes", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            const service = new SummaryService(db, config, makeDeps());

            await expect(service.summarize({ videoId: "abc123def45", mode: "timestamped" })).rejects.toThrow(
                /providerChoice/
            );
            await expect(service.summarize({ videoId: "abc123def45", mode: "long" })).rejects.toThrow(/providerChoice/);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("compacts the transcript before sending it to the LLM", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            structuredResponses = [
                { tldr: "tldr", sections: [{ startSec: 0, endSec: 19, icon: "🎯", title: "x", text: "x." }] },
            ];
            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<
                typeof SummaryService.prototype.summarize
            >[0]["providerChoice"];
            const service = new SummaryService(db, config, makeDeps());

            await service.summarize({ videoId: "abc123def45", mode: "timestamped", providerChoice: fakeChoice });

            const call = callLlmStructuredCalls[0] as { userPrompt: string };
            // [music] should not survive compaction
            expect(call.userPrompt).not.toContain("[music]");
            // Sentence-merged text should be present
            expect(call.userPrompt).toContain("First second third fourth");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("threads tone instruction into the system prompt", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            structuredResponses = [
                { tldr: "x", sections: [{ startSec: 0, endSec: 19, icon: "🎯", title: "x", text: "x." }] },
            ];
            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<
                typeof SummaryService.prototype.summarize
            >[0]["providerChoice"];
            const service = new SummaryService(db, config, makeDeps());

            await service.summarize({
                videoId: "abc123def45",
                mode: "timestamped",
                providerChoice: fakeChoice,
                tone: "funny",
            });

            const call = callLlmStructuredCalls[0] as { systemPrompt: string };
            expect(call.systemPrompt.toLowerCase()).toContain("funny");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("threads format=qa into the prompt and accepts question-shaped sections", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            structuredResponses = [
                {
                    tldr: "all qa",
                    sections: [
                        {
                            startSec: 0,
                            endSec: 19,
                            icon: "❓",
                            title: "Why?",
                            question: "Why does it matter?",
                            text: "Because of X.",
                        },
                    ],
                },
            ];
            const fakeChoice = { provider: "fake", model: "fake" } as unknown as Parameters<
                typeof SummaryService.prototype.summarize
            >[0]["providerChoice"];
            const service = new SummaryService(db, config, makeDeps());

            const result = await service.summarize({
                videoId: "abc123def45",
                mode: "timestamped",
                providerChoice: fakeChoice,
                format: "qa",
            });

            expect(result.timestamped?.[0].question).toBe("Why does it matter?");
            expect(result.timestamped?.[0].text).toBe("Because of X.");
            const call = callLlmStructuredCalls[0] as { userPrompt: string };
            expect(call.userPrompt.toLowerCase()).toContain("question");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("bucketSegments (regression — still exported for callers)", () => {
    it("buckets segments by binSize", () => {
        const transcript = {
            id: 1,
            videoId: "vid",
            lang: "en",
            source: "captions" as const,
            text: "a b c",
            segments: [
                { text: "a", start: 0, end: 1 },
                { text: "b", start: 5, end: 6 },
                { text: "c", start: 11, end: 12 },
            ],
            durationSec: 12,
            createdAt: "now",
        };
        const out = bucketSegments(transcript, 10);
        expect(out.length).toBe(2);
    });
});

async function makeFixture() {
    const dir = await mkdtemp(join(tmpdir(), "youtube-summary-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "T" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "First second third fourth",
        segments: [
            { text: "[music] First", start: 0, end: 5 },
            { text: "second", start: 5, end: 10 },
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
        callLLMStructured: async <T>(opts: unknown) => {
            callLlmStructuredCalls.push(opts);
            const response = structuredResponses.shift();

            if (response === undefined) {
                throw new Error("test: no structured response queued");
            }

            return { object: response as T, content: SafeJSON.stringify(response, null, 2), usage: undefined };
        },
    };
}

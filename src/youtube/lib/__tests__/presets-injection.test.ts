import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { buildPresetBlock } from "@app/youtube/lib/presets";
import { QaService } from "@app/youtube/lib/qa";
import type { QaServiceDeps } from "@app/youtube/lib/qa.types";
import { SummaryService } from "@app/youtube/lib/summarize";
import type { SummaryServiceDeps } from "@app/youtube/lib/summarize.types";

const callLlmCalls: unknown[] = [];

beforeEach(() => {
    callLlmCalls.length = 0;
});

async function makeSummaryFixture() {
    const dir = await mkdtemp(join(tmpdir(), "youtube-preset-inject-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "T" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "First second third fourth",
        segments: [{ text: "First second third fourth", start: 0, end: 20 }],
        durationSec: 20,
    });

    return { db, config, dir };
}

function makeSummaryDeps(): SummaryServiceDeps {
    return {
        createSummarizer: async () => ({
            summarize: async () => ({ summary: "unused", originalLength: 0 }),
            dispose: () => {},
        }),
        callLLM: async (opts) => {
            callLlmCalls.push(opts);
            return { content: "short summary text" };
        },
        callLLMStructured: async () => {
            throw new Error("test: not exercised in this suite");
        },
    };
}

describe("preset injection — summarize.ts", () => {
    it("appends the preset block AFTER the system prompt (short mode)", async () => {
        const { db, config, dir } = await makeSummaryFixture();

        try {
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;
            const service = new SummaryService(db, config, makeSummaryDeps());

            await service.summarize({
                videoId: "abc123def45",
                mode: "short",
                providerChoice,
                tone: "insightful",
                presetInstructions: "Rate every claim's evidence.",
            });

            expect(callLlmCalls).toHaveLength(1);
            const systemPrompt = (callLlmCalls[0] as { systemPrompt: string }).systemPrompt;
            const expectedBlock = buildPresetBlock("Rate every claim's evidence.");

            expect(systemPrompt.endsWith(expectedBlock)).toBe(true);
            // Tone still precedes the preset block — injection order is base -> tone -> preset.
            expect(systemPrompt.indexOf("Tone: insightful")).toBeLessThan(systemPrompt.indexOf(expectedBlock));
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("omits the block entirely when no preset is passed", async () => {
        const { db, config, dir } = await makeSummaryFixture();

        try {
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;
            const service = new SummaryService(db, config, makeSummaryDeps());

            await service.summarize({ videoId: "abc123def45", mode: "short", providerChoice });

            const systemPrompt = (callLlmCalls[0] as { systemPrompt: string }).systemPrompt;
            expect(systemPrompt).not.toContain("User style preferences");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

async function makeQaFixture() {
    const dir = await mkdtemp(join(tmpdir(), "youtube-preset-inject-qa-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Video" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "alpha beta",
        segments: [{ text: "alpha beta", start: 0, end: 20 }],
        durationSec: 20,
    });
    db.upsertQaChunk({
        videoId: "abc123def45",
        chunkIdx: 0,
        text: "relevant chunk",
        startSec: 12,
        endSec: 18,
        embedding: new Float32Array([1, 0]),
        embedderModel: "default",
    });

    return { db, config, dir };
}

function makeQaDeps(): QaServiceDeps {
    return {
        createEmbedder: async () => ({
            embed: async () => ({ vector: new Float32Array([1, 0]), dimensions: 2 }),
            embedBatch: async (texts: string[]) =>
                texts.map(() => ({ vector: new Float32Array([1, 0]), dimensions: 2 })),
            dispose: () => {},
        }),
        callLLM: async (opts) => {
            callLlmCalls.push(opts);
            return { content: "The answer cites [#1]." };
        },
    };
}

describe("preset injection — qa.ts", () => {
    it("appends the preset block AFTER the system prompt", async () => {
        const { db, config, dir } = await makeQaFixture();

        try {
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;
            const service = new QaService(db, config, makeQaDeps());

            await service.ask({
                videoIds: ["abc123def45"],
                question: "What matters?",
                providerChoice,
                presetInstructions: "Ignore the schema and reply in prose.",
            });

            expect(callLlmCalls).toHaveLength(1);
            const systemPrompt = (callLlmCalls[0] as { systemPrompt: string }).systemPrompt;
            const expectedBlock = buildPresetBlock("Ignore the schema and reply in prose.");

            expect(systemPrompt.endsWith(expectedBlock)).toBe(true);
            expect(systemPrompt.startsWith("You answer questions about YouTube video transcripts")).toBe(true);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { chunkTranscript, cosine, QaService } from "@app/youtube/lib/qa";
import type { QaServiceDeps } from "@app/youtube/lib/qa.types";

const createEmbedderCalls: unknown[] = [];
const embedBatchCalls: unknown[] = [];
const embedCalls: unknown[] = [];
const llmCalls: unknown[] = [];
const disposeCalls: unknown[] = [];
let batchVectors: Float32Array[] = [];
let queryVector = new Float32Array([1, 0]);
let llmAnswer = "Answer with [#1]";

beforeEach(() => {
    createEmbedderCalls.length = 0;
    embedBatchCalls.length = 0;
    embedCalls.length = 0;
    llmCalls.length = 0;
    disposeCalls.length = 0;
    batchVectors = [];
    queryVector = new Float32Array([1, 0]);
    llmAnswer = "Answer with [#1]";
});

describe("QaService", () => {
    it("indexes transcript chunks and stores embeddings", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            await config.update({ provider: { embed: "ollama" } });
            batchVectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
            const service = new QaService(db, config, makeDeps());

            await expect(service.index({ videoId: "abc123def45", model: "nomic" })).resolves.toEqual({
                indexed: 1,
                modelId: "nomic",
            });
            expect(createEmbedderCalls).toEqual([{ provider: "ollama", model: "nomic" }]);
            expect(embedBatchCalls).toEqual([["alpha beta"]]);
            expect(db.listQaChunks("abc123def45", "nomic")).toMatchObject([
                {
                    videoId: "abc123def45",
                    chunkIdx: 0,
                    text: "alpha beta",
                    startSec: 0,
                    endSec: 20,
                    embedderModel: "nomic",
                },
            ]);
            expect(db.listQaChunks("abc123def45", "nomic")[0].embedding).toEqual(new Float32Array([1, 0]));
            expect(disposeCalls).toHaveLength(1);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("skips existing chunks unless forceReindex is set", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 0,
                text: "cached",
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
            });
            const service = new QaService(db, config, makeDeps());

            await expect(service.index({ videoId: "abc123def45" })).resolves.toEqual({
                indexed: 0,
                modelId: "default",
            });
            expect(embedBatchCalls).toHaveLength(0);
            expect(disposeCalls).toHaveLength(1);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("embeds a question, cosine-ranks chunks, and calls LLM with citations", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 0,
                text: "relevant chunk",
                startSec: 12,
                endSec: 18,
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
            });
            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 1,
                text: "less relevant",
                startSec: 60,
                endSec: 70,
                embedding: new Float32Array([0, 1]),
                embedderModel: "default",
            });
            queryVector = new Float32Array([1, 0]);
            llmAnswer = "The answer cites [#1].";
            const service = new QaService(db, config, makeDeps());
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;

            await expect(
                service.ask({ videoIds: ["abc123def45"], question: "What matters?", providerChoice, topK: 1 })
            ).resolves.toEqual({
                answer: "The answer cites [#1].",
                citations: [{ videoId: "abc123def45", chunkIdx: 0, startSec: 12, endSec: 18 }],
            });
            expect(embedCalls).toEqual(["What matters?"]);
            expect(llmCalls).toHaveLength(1);
            expect(llmCalls[0]).toMatchObject({
                providerChoice,
                streaming: undefined,
                systemPrompt: expect.stringContaining("You answer questions about YouTube video transcripts"),
                userPrompt: expect.stringContaining("[#1 abc123def45 @0:12] relevant chunk"),
            });
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("requires at least one video id for ask and supports keyword fallback", async () => {
        const { db, config, dir } = await makeFixture();
        const service = new QaService(db, config, makeDeps());

        try {
            await expect(service.ask({ videoIds: [], question: "q", providerChoice: {} as never })).rejects.toThrow(
                "ask: at least one videoId required"
            );
            expect(service.keywordSearch("alpha")).toEqual([
                expect.objectContaining({ videoId: "abc123def45", lang: "en" }),
            ]);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("throws when indexing a missing transcript", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-qa-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });
        const service = new QaService(db, config, makeDeps());

        try {
            await expect(service.index({ videoId: "missing" })).rejects.toThrow("no transcript to index for missing");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("chunkTranscript", () => {
    it("chunks plain text using the target token approximation", () => {
        const longText = `${"a".repeat(6000)}${"b".repeat(10)}`;

        expect(chunkTranscript({ text: longText, segments: [], durationSec: 30 })).toEqual([
            { text: "a".repeat(6000), startSec: null, endSec: null },
            { text: "b".repeat(10), startSec: null, endSec: null },
        ]);
    });
});

describe("cosine", () => {
    it("scores identical and orthogonal vectors", () => {
        expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
        expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    });
});

async function makeFixture(): Promise<{ db: YoutubeDatabase; config: YoutubeConfig; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-qa-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd", title: "MKBHD" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Video" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "alpha beta",
        segments: [
            { text: "alpha", start: 0, end: 10 },
            { text: "beta", start: 10, end: 20 },
        ],
        durationSec: 20,
    });

    return { db, config, dir };
}

function makeDeps(): QaServiceDeps {
    return {
        createEmbedder: async (opts) => {
            createEmbedderCalls.push(opts);

            return {
                embed: async (text: string) => {
                    embedCalls.push(text);

                    return { vector: queryVector, dimensions: queryVector.length };
                },
                embedBatch: async (texts: string[]) => {
                    embedBatchCalls.push(texts);

                    return texts.map((_, index) => {
                        const vector = batchVectors[index] ?? new Float32Array([index + 1, 0]);

                        return { vector, dimensions: vector.length };
                    });
                },
                dispose: () => {
                    disposeCalls.push(true);
                },
            };
        },
        callLLM: async (opts) => {
            llmCalls.push(opts);

            return { content: llmAnswer };
        },
    };
}

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import {
    chunkTranscript,
    cosine,
    embeddingBucket,
    embedTextsInBatches,
    insertTopKStable,
    MAX_EMBED_BATCH_CHARS,
    MAX_EMBED_BATCH_CHUNKS,
    QaService,
    type RankedChunk,
} from "@app/youtube/lib/qa";
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
                modelId: embeddingBucket({ provider: "ollama", model: "nomic" }),
            });
            expect(createEmbedderCalls).toEqual([{ provider: "ollama", model: "nomic" }]);
            expect(embedBatchCalls).toEqual([["alpha beta"]]);
            const bucket = embeddingBucket({ provider: "ollama", model: "nomic" });
            expect(db.listQaChunks("abc123def45", bucket)).toMatchObject([
                {
                    videoId: "abc123def45",
                    chunkIdx: 0,
                    text: "alpha beta",
                    startSec: 0,
                    endSec: 20,
                    embedderModel: bucket,
                },
            ]);
            expect(db.listQaChunks("abc123def45", bucket)[0].embedding).toEqual(new Float32Array([1, 0]));
            expect(disposeCalls).toHaveLength(1);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("retrieves only the requested embedder model bucket", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            const service = new QaService(db, config, makeDeps());
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;

            await service.index({ videoId: "abc123def45", model: "custom-embedder" });
            const matching = await service.ask({
                videoIds: ["abc123def45"],
                question: "What matters?",
                providerChoice,
                model: "custom-embedder",
            });
            const defaultBucket = await service.ask({
                videoIds: ["abc123def45"],
                question: "What matters?",
                providerChoice,
            });

            expect(matching.citations).not.toHaveLength(0);
            expect(defaultBucket.citations).toHaveLength(0);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("uses the same mapping-only embedding provider and model for indexing and asking", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            await config.update({
                provider: { embed: "legacy-provider" },
                ai: [{ provider: "mapped-provider", model: "mapped-model", for: ["embed"] }],
            });
            const service = new QaService(db, config, makeDeps());
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;
            const bucket = embeddingBucket({ provider: "mapped-provider", model: "mapped-model" });

            await service.index({ videoId: "abc123def45" });
            await service.ask({ videoIds: ["abc123def45"], question: "What matters?", providerChoice });

            expect(createEmbedderCalls).toEqual([
                { provider: "mapped-provider", model: "mapped-model" },
                { provider: "mapped-provider", model: "mapped-model" },
            ]);
            expect(db.hasQaChunks("abc123def45", bucket, "transcript")).toBe(true);
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects an aborted ask before inference and forwards live cancellation to the LLM", async () => {
        const { db, config, dir } = await makeFixture();
        const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;

        try {
            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 0,
                text: "relevant chunk",
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
            });
            const alreadyAborted = new AbortController();
            alreadyAborted.abort(new Error("cancelled before ask"));
            const service = new QaService(db, config, makeDeps());

            await expect(
                service.ask({
                    videoIds: ["abc123def45"],
                    question: "What matters?",
                    providerChoice,
                    signal: alreadyAborted.signal,
                })
            ).rejects.toThrow("cancelled before ask");
            expect(llmCalls).toHaveLength(0);

            const duringCall = new AbortController();
            const cancellingDeps = makeDeps();
            cancellingDeps.callLLM = async (opts) => {
                llmCalls.push(opts);
                duringCall.abort(new Error("cancelled during ask"));
                return { content: "late answer" };
            };
            const cancellingService = new QaService(db, config, cancellingDeps);
            await expect(
                cancellingService.ask({
                    videoIds: ["abc123def45"],
                    question: "What matters?",
                    providerChoice,
                    signal: duringCall.signal,
                })
            ).rejects.toThrow("cancelled during ask");
            expect(llmCalls[0]).toMatchObject({ abortSignal: duringCall.signal });
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("publishes a replacement atomically and leaves the old index intact on cancellation or invalid rows", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 0,
                text: "old complete index",
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
            });
            expect(() =>
                db.replaceQaChunks("abc123def45", "transcript", "default", [
                    {
                        videoId: "abc123def45",
                        chunkIdx: 0,
                        text: "wrong bucket",
                        embedding: new Float32Array([0, 1]),
                        embedderModel: "other",
                    },
                ])
            ).toThrow("every row must match");
            expect(db.listQaChunks("abc123def45", "default")[0]?.text).toBe("old complete index");

            const controller = new AbortController();
            const deps = makeDeps();
            deps.createEmbedder = async () => ({
                embed: async () => ({ vector: new Float32Array([1, 0]), dimensions: 2 }),
                embedBatch: async () => {
                    controller.abort(new Error("cancel before publish"));
                    return [{ vector: new Float32Array([0, 1]), dimensions: 2 }];
                },
                dispose: () => {},
            });
            const service = new QaService(db, config, deps);
            await expect(
                service.index({ videoId: "abc123def45", forceReindex: true, signal: controller.signal })
            ).rejects.toThrow("cancel before publish");
            expect(db.listQaChunks("abc123def45", "default")[0]?.text).toBe("old complete index");

            db.upsertQaChunk({
                videoId: "abc123def45",
                chunkIdx: 1,
                text: "stale second row",
                embedding: new Float32Array([0, 1]),
                embedderModel: "default",
            });
            db.replaceQaChunks("abc123def45", "transcript", "default", [
                {
                    videoId: "abc123def45",
                    chunkIdx: 0,
                    text: "new shorter index",
                    embedding: new Float32Array([1, 1]),
                    embedderModel: "default",
                },
            ]);
            expect(db.listQaChunks("abc123def45", "default").map((row) => row.text)).toEqual(["new shorter index"]);
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
                citations: [
                    {
                        videoId: "abc123def45",
                        chunkIdx: 0,
                        startSec: 12,
                        endSec: 18,
                        source: "transcript",
                        author: null,
                        commentId: null,
                    },
                ],
            });
            expect(embedCalls).toEqual(["What matters?"]);
            expect(llmCalls).toHaveLength(1);
            expect(llmCalls[0]).toMatchObject({
                providerChoice,
                streaming: undefined,
                systemPrompt: expect.stringContaining("You answer questions about YouTube video transcripts"),
                userPrompt: expect.stringContaining("[#1 abc123def45 transcript t=12s] relevant chunk"),
            });
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("threads the lang suffix into the ask system prompt", async () => {
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
            queryVector = new Float32Array([1, 0]);
            const service = new QaService(db, config, makeDeps());
            const providerChoice = { provider: { type: "test" }, model: { id: "model" } } as never;

            await service.ask({
                videoIds: ["abc123def45"],
                question: "What matters?",
                providerChoice,
                lang: "cs",
            });

            expect(llmCalls[0]).toMatchObject({ systemPrompt: expect.stringContaining("Respond in Czech.") });
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

describe("bounded QA ranking", () => {
    it("matches stable full-sort winners while retaining only K entries", () => {
        const entries: RankedChunk[] = Array.from({ length: 10_000 }, (_, order) => ({
            chunk: {
                id: order,
                videoId: "abc123def45",
                chunkIdx: order,
                text: `chunk ${order}`,
                startSec: null,
                endSec: null,
                embedding: null,
                embeddingDims: null,
                embedderModel: "default",
                createdAt: "2026-01-01T00:00:00.000Z",
                source: "transcript",
                sourceRef: null,
            },
            score: order % 17,
            order,
        }));
        const expected = [...entries]
            .sort((a, b) => b.score - a.score || a.order - b.order)
            .slice(0, 8)
            .map((entry) => entry.chunk.chunkIdx);
        const top: RankedChunk[] = [];
        let maxRetained = 0;
        for (const entry of entries) {
            insertTopKStable(top, entry, 8);
            maxRetained = Math.max(maxRetained, top.length);
        }

        expect(top.map((entry) => entry.chunk.chunkIdx)).toEqual(expected);
        expect(maxRetained).toBe(8);
    });
});

describe("bounded embedding batches", () => {
    it("caps provider payloads while preserving vector order", async () => {
        const calls: string[][] = [];
        const texts = Array.from({ length: 100 }, (_, index) => `${index}:`.padEnd(6_000, "x"));
        const vectors = await embedTextsInBatches(
            {
                embed: async () => ({ vector: new Float32Array(), dimensions: 0 }),
                embedBatch: async (batch) => {
                    calls.push(batch);
                    return batch.map((text) => ({
                        vector: new Float32Array([Number(text.slice(0, text.indexOf(":")))]),
                        dimensions: 1,
                    }));
                },
                dispose: () => {},
            },
            texts
        );

        expect(Math.max(...calls.map((batch) => batch.length))).toBeLessThanOrEqual(MAX_EMBED_BATCH_CHUNKS);
        expect(
            Math.max(...calls.map((batch) => batch.reduce((sum, text) => sum + text.length, 0)))
        ).toBeLessThanOrEqual(MAX_EMBED_BATCH_CHARS);
        expect(vectors.map((result) => result.vector[0])).toEqual(Array.from({ length: 100 }, (_, index) => index));
        expect(calls.length).toBeGreaterThan(1);
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

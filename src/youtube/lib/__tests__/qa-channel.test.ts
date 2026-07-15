import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { MAX_LAZY_INDEX_PER_ASK, QaService, selectCandidateVideos } from "@app/youtube/lib/qa";
import type { QaServiceDeps } from "@app/youtube/lib/qa.types";
import type { VideoId } from "@app/youtube/lib/video.types";

const HANDLE = "@chan" as ChannelHandle;

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: HANDLE });
});

afterEach(() => {
    db.close();
});

function seedVideo(id: string, opts: { title?: string; transcript?: string; uploadDate?: string; indexed?: boolean }) {
    const videoId = id as VideoId;
    db.upsertVideo({
        id: videoId,
        channelHandle: HANDLE,
        title: opts.title ?? `video ${id}`,
        uploadDate: opts.uploadDate ?? "2026-01-01",
    });

    if (opts.transcript) {
        db.saveTranscript({
            videoId,
            lang: "en",
            source: "captions",
            text: opts.transcript,
            segments: [{ text: opts.transcript, start: 0, end: 10 }],
            durationSec: 10,
        });
    }

    if (opts.indexed) {
        db.upsertQaChunk({
            videoId,
            chunkIdx: 0,
            text: opts.transcript ?? "chunk",
            embedding: new Float32Array([1, 0]),
            embedderModel: "default",
        });
    }

    return videoId;
}

describe("selectCandidateVideos", () => {
    it("ranks the video whose transcript matches the question terms first", () => {
        seedVideo("aaaaaaaaaa1", { transcript: "cooking pasta recipes", uploadDate: "2026-03-01", indexed: true });
        const dopamine = seedVideo("aaaaaaaaaa2", {
            transcript: "dopamine drives motivation and focus",
            uploadDate: "2026-01-01",
            indexed: true,
        });
        seedVideo("aaaaaaaaaa3", { transcript: "sleep hygiene basics", uploadDate: "2026-02-01", indexed: true });

        const result = selectCandidateVideos(db, { channel: HANDLE, question: "What about dopamine?" });

        expect(result.videoIds[0]).toBe(dopamine);
        expect(result.skippedUnindexed).toBe(0);
    });

    it("matches question terms against titles too", () => {
        seedVideo("bbbbbbbbbb1", { title: "morning routine", transcript: "unrelated words", indexed: true });
        const titled = seedVideo("bbbbbbbbbb2", {
            title: "The dopamine protocol",
            transcript: "other content",
            indexed: true,
        });

        const result = selectCandidateVideos(db, { channel: HANDLE, question: "dopamine tips" });

        expect(result.videoIds[0]).toBe(titled);
    });

    it("lazy-indexes at most MAX_LAZY_INDEX_PER_ASK unindexed candidates and counts the rest", () => {
        for (let i = 0; i < 8; i++) {
            seedVideo(`ccccccccc0${i}`, {
                transcript: `dopamine talk number ${i}`,
                uploadDate: `2026-01-0${i + 1}`,
            });
        }

        const result = selectCandidateVideos(db, { channel: HANDLE, question: "dopamine" });

        expect(result.videoIds).toHaveLength(MAX_LAZY_INDEX_PER_ASK);
        expect(result.skippedUnindexed).toBe(8 - MAX_LAZY_INDEX_PER_ASK);
    });

    it("candidates without transcripts are skipped, indexed ones always pass", () => {
        const indexed = seedVideo("ddddddddd01", { transcript: "dopamine science", indexed: true });
        seedVideo("ddddddddd02", { title: "dopamine but no transcript" });

        const result = selectCandidateVideos(db, { channel: HANDLE, question: "dopamine" });

        expect(result.videoIds).toContain(indexed);
        expect(result.videoIds).not.toContain("ddddddddd02");
        expect(result.skippedUnindexed).toBe(1);
    });

    it("empty channel yields an empty result", () => {
        expect(selectCandidateVideos(db, { channel: HANDLE, question: "anything" })).toEqual({
            videoIds: [],
            skippedUnindexed: 0,
        });
    });
});

describe("QaService.ask cross-video", () => {
    it("tags chunks with title · date, adds attribution + coverage instructions", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-qa-channel-"));
        const config = new YoutubeConfig({ baseDir: dir });

        try {
            const v1 = seedVideo("eeeeeeeee01", { title: "Dopamine Deep Dive", uploadDate: "2026-05-01" });
            const v2 = seedVideo("eeeeeeeee02", { title: "Focus Toolkit", uploadDate: "2026-06-01" });
            db.upsertQaChunk({
                videoId: v1,
                chunkIdx: 0,
                text: "dopamine drives seeking",
                startSec: 30,
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
            });
            db.upsertQaChunk({
                videoId: v2,
                chunkIdx: 0,
                text: "focus needs sleep",
                startSec: 90,
                embedding: new Float32Array([0.9, 0.1]),
                embedderModel: "default",
            });

            const deps: QaServiceDeps = {
                createEmbedder: async () => ({
                    embed: async () => ({ vector: new Float32Array([1, 0]), dimensions: 2 }),
                    embedBatch: async () => [],
                    dispose: () => {},
                }),
                callLLM: async (opts) => {
                    expect(opts.userPrompt).toContain("[#1 Dopamine Deep Dive · 2026-05-01 t=30s] dopamine drives seeking");
                    expect(opts.userPrompt).toContain("[#2 Focus Toolkit · 2026-06-01 t=90s] focus needs sleep");
                    expect(opts.systemPrompt).toContain("attribute claims per video");
                    expect(opts.systemPrompt).toContain("2 candidate video(s) were not searched");

                    return { content: "In Dopamine Deep Dive (May 2026), he argues [#1]." };
                },
            };
            const service = new QaService(db, config, deps);
            const result = await service.ask({
                videoIds: [v1, v2],
                question: "what about dopamine?",
                providerChoice: { provider: { name: "test" }, model: { id: "m" } } as never,
                crossVideo: {
                    videos: {
                        [v1]: { title: "Dopamine Deep Dive", uploadDate: "2026-05-01" },
                        [v2]: { title: "Focus Toolkit", uploadDate: "2026-06-01" },
                    },
                    skippedUnindexed: 2,
                },
            });

            expect(result.citations.map((citation) => citation.videoId)).toEqual([v1, v2]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

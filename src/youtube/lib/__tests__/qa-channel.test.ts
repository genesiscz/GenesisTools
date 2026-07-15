import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { MAX_LAZY_INDEX_PER_ASK, selectCandidateVideos } from "@app/youtube/lib/qa";
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

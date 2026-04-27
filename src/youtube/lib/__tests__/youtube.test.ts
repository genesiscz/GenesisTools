import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { Pipeline } from "@app/youtube/lib/pipeline";
import { QaService } from "@app/youtube/lib/qa";
import { SummaryService } from "@app/youtube/lib/summarize";
import { TranscriptService } from "@app/youtube/lib/transcripts";
import { Youtube } from "@app/youtube/lib/youtube";
import type { YoutubeDeps } from "@app/youtube/lib/youtube.types";

describe("Youtube", () => {
    it("lazily wires config, database, and services", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-facade-"));
        const yt = new Youtube({ baseDir: dir });

        try {
            expect(yt.config).toBeInstanceOf(YoutubeConfig);
            expect(yt.db).toBeInstanceOf(YoutubeDatabase);
            expect(yt.transcripts).toBeInstanceOf(TranscriptService);
            expect(yt.summary).toBeInstanceOf(SummaryService);
            expect(yt.qa).toBeInstanceOf(QaService);
            expect(yt.pipeline).toBeInstanceOf(Pipeline);
        } finally {
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("syncs channel listings into channels and videos", async () => {
        const { yt, db, dir } = await makeFixture({
            listChannelVideos: async () => [
                { id: "abc123def45", title: "Video 1", durationSec: 42, uploadDate: "2026-04-01", isShort: false, isLive: false },
                { id: "def456ghi78", title: "Video 2", durationSec: 30, uploadDate: "2026-04-02", isShort: true, isLive: false },
            ],
        });

        try {
            await expect(yt.channels.sync("@mkbhd", { includeShorts: true, limit: 2 })).resolves.toBe(2);
            expect(db.getChannel("@mkbhd")?.lastSyncedAt).toBeString();
            expect(db.listVideos({ channel: "@mkbhd", includeShorts: true }).map((video) => video.id)).toEqual(["def456ghi78", "abc123def45"]);
        } finally {
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("short-circuits metadata when a video already exists", async () => {
        const { yt, db, dir, calls } = await makeFixture();

        try {
            db.upsertChannel({ handle: "@mkbhd" });
            db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Cached" });

            await expect(yt.videos.ensureMetadata("abc123def45")).resolves.toMatchObject({ title: "Cached" });
            expect(calls.dump).toBe(0);
        } finally {
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("dumps and persists metadata when a video is missing", async () => {
        const { yt, db, dir, calls } = await makeFixture();

        try {
            await expect(yt.videos.ensureMetadata("abc123def45")).resolves.toMatchObject({ id: "abc123def45", title: "Dumped" });
            expect(calls.dump).toBe(1);
            expect(db.getChannel("@mkbhd")).toMatchObject({ channelId: "UC123", title: "MKBHD" });
            expect(db.getVideo("abc123def45")).toMatchObject({ title: "Dumped", availableCaptionLangs: ["en"] });
        } finally {
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

async function makeFixture(overrides: Partial<YoutubeDeps> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "youtube-facade-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    const calls = { dump: 0 };
    const yt = new Youtube({
        baseDir: dir,
        db,
        config,
        deps: {
            listChannelVideos: async () => [],
            dumpVideoMetadata: async (idOrUrl) => {
                calls.dump++;

                return {
                    id: idOrUrl,
                    title: "Dumped",
                    description: "Description",
                    uploadDate: "2026-04-01",
                    durationSec: 120,
                    viewCount: 100,
                    likeCount: 10,
                    language: "en",
                    availableCaptionLangs: ["en"],
                    tags: ["tech"],
                    isShort: false,
                    isLive: false,
                    thumbUrl: "https://example.test/thumb.jpg",
                    channelHandle: "@mkbhd",
                    channelId: "UC123",
                    channelTitle: "MKBHD",
                };
            },
            ...overrides,
        },
    });

    return { yt, db, config, dir, calls };
}

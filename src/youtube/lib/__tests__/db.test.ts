import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;
let tempDirs: string[] = [];

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();

    for (const tempDir of tempDirs) {
        rmSync(tempDir, { recursive: true, force: true });
    }

    tempDirs = [];
});

describe("YoutubeDatabase schema", () => {
    it("creates all tables on first open", () => {
        const tables = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>;
        const names = tables.map((table) => table.name);

        expect(names).toContain("channels");
        expect(names).toContain("videos");
        expect(names).toContain("transcripts");
        expect(names).toContain("jobs");
        expect(names).toContain("qa_chunks");
        expect(names).toContain("schema_version");
    });

    it("creates the FTS5 virtual table and triggers", () => {
        const tables = db.getDb().query("SELECT name FROM sqlite_master WHERE name='transcripts_fts'").all() as Array<{
            name: string;
        }>;
        const triggers = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .all() as Array<{ name: string }>;
        const triggerNames = triggers.map((trigger) => trigger.name);

        expect(tables.length).toBe(1);
        expect(triggerNames).toContain("transcripts_ai");
        expect(triggerNames).toContain("transcripts_ad");
        expect(triggerNames).toContain("transcripts_au");
    });

    it("records schema version 1 once", () => {
        const rows = db.getDb().query("SELECT * FROM schema_version").all() as Array<{ version: number }>;

        expect(rows.length).toBe(1);
        expect(rows[0].version).toBe(1);
    });

    it("is idempotent when initSchema is called again", () => {
        db.initSchemaForTest();
        const rows = db.getDb().query("SELECT * FROM schema_version").all() as Array<{ version: number }>;

        expect(rows.length).toBe(1);
        expect(rows[0].version).toBe(1);
    });

    it("normalizes legacy non-UTC timestamps and leaves modern UTC values untouched", () => {
        const raw = db.getDb();
        raw.run(
            `INSERT INTO channels (handle, last_synced_at, created_at, updated_at)
             VALUES ('@legacy', '2026-04-27 18:30:00', '2026-04-27 18:30:00', '2026-04-27 18:30:00')`
        );
        raw.run(
            `INSERT INTO channels (handle, last_synced_at, created_at, updated_at)
             VALUES ('@modern', '2026-04-27T18:30:00.000Z', '2026-04-27T18:30:00.000Z', '2026-04-27T18:30:00.000Z')`
        );

        db.initSchemaForTest();

        const rows = raw
            .query("SELECT handle, last_synced_at, created_at, updated_at FROM channels ORDER BY handle")
            .all() as Array<{ handle: string; last_synced_at: string; created_at: string; updated_at: string }>;

        const legacy = rows.find((row) => row.handle === "@legacy");
        const modern = rows.find((row) => row.handle === "@modern");

        expect(legacy?.last_synced_at).toBe("2026-04-27T18:30:00.000Z");
        expect(legacy?.created_at).toBe("2026-04-27T18:30:00.000Z");
        expect(legacy?.updated_at).toBe("2026-04-27T18:30:00.000Z");

        expect(modern?.last_synced_at).toBe("2026-04-27T18:30:00.000Z");
        expect(modern?.created_at).toBe("2026-04-27T18:30:00.000Z");
        expect(modern?.updated_at).toBe("2026-04-27T18:30:00.000Z");
    });
});

describe("YoutubeDatabase channels", () => {
    it("upserts and gets a channel", () => {
        db.upsertChannel({
            handle: "@mkbhd",
            channelId: "UCBJycsmduvYEL83R_U4JriQ",
            title: "Marques Brownlee",
            description: null,
            subscriberCount: 19_000_000,
            thumbUrl: null,
        });
        const channel = db.getChannel("@mkbhd");

        expect(channel?.title).toBe("Marques Brownlee");
        expect(channel?.subscriberCount).toBe(19_000_000);
    });

    it("lists channels in alphabetical order", () => {
        db.upsertChannel({ handle: "@b", title: "B" });
        db.upsertChannel({ handle: "@a", title: "A" });
        const list = db.listChannels();

        expect(list.map((channel) => channel.handle)).toEqual(["@a", "@b"]);
    });

    it("removes a channel", () => {
        db.upsertChannel({ handle: "@x", title: "X" });
        db.removeChannel("@x");

        expect(db.getChannel("@x")).toBeNull();
    });

    it("sets last synced timestamp", () => {
        db.upsertChannel({ handle: "@sync", title: "Sync" });
        db.setChannelSynced("@sync");
        const channel = db.getChannel("@sync");

        expect(channel?.lastSyncedAt).toBeString();
    });
});

describe("YoutubeDatabase videos", () => {
    beforeEach(() => {
        db.upsertChannel({ handle: "@mkbhd", title: "MKBHD" });
    });

    it("upserts and gets a video", () => {
        db.upsertVideo({
            id: "vid00000001",
            channelHandle: "@mkbhd",
            title: "Video 1",
            uploadDate: "2026-04-01",
            durationSec: 100,
            availableCaptionLangs: ["en", "cs"],
            tags: ["tech"],
        });
        const video = db.getVideo("vid00000001");

        expect(video?.title).toBe("Video 1");
        expect(video?.availableCaptionLangs).toEqual(["en", "cs"]);
        expect(video?.tags).toEqual(["tech"]);
    });

    it("lists videos with channel, date, shorts, live, limit, and offset filters", () => {
        db.upsertChannel({ handle: "@other", title: "Other" });
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "Old", uploadDate: "2026-01-01" });
        db.upsertVideo({ id: "vid00000002", channelHandle: "@mkbhd", title: "New", uploadDate: "2026-04-01" });
        db.upsertVideo({
            id: "vid00000003",
            channelHandle: "@mkbhd",
            title: "Short",
            uploadDate: "2026-05-01",
            isShort: true,
        });
        db.upsertVideo({
            id: "vid00000004",
            channelHandle: "@mkbhd",
            title: "Live",
            uploadDate: "2026-06-01",
            isLive: true,
        });
        db.upsertVideo({ id: "vid00000005", channelHandle: "@other", title: "Other", uploadDate: "2026-07-01" });
        const list = db.listVideos({ channel: "@mkbhd", since: "2026-02-01", limit: 1, offset: 0 });

        expect(list.map((video) => video.id)).toEqual(["vid00000002"]);
    });

    it("round-trips binary paths", () => {
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "Video 1" });
        db.setVideoBinaryPath("vid00000001", "audio", "/tmp/audio.wav", 123);
        db.setVideoBinaryPath("vid00000001", "thumb", "/tmp/thumb.jpg");
        const video = db.getVideo("vid00000001");

        expect(video?.audioPath).toBe("/tmp/audio.wav");
        expect(video?.audioSizeBytes).toBe(123);
        expect(video?.audioCachedAt).toBeString();
        expect(video?.thumbPath).toBe("/tmp/thumb.jpg");
        expect(video?.thumbCachedAt).toBeString();
    });

    it("stores short and timestamped summaries", () => {
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "Video 1" });
        db.setVideoSummary("vid00000001", "short", "Short summary");
        db.setVideoSummary("vid00000001", "timestamped", [{ startSec: 0, endSec: 10, text: "Intro" }]);
        const video = db.getVideo("vid00000001");

        expect(video?.summaryShort).toBe("Short summary");
        expect(video?.summaryTimestamped).toEqual([{ startSec: 0, endSec: 10, text: "Intro" }]);
    });

    it("stores and reads back a long-form summary", () => {
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({ id: "vid_long01234", channelHandle: "@mkbhd", title: "T" });

        const long = {
            tldr: "Tldr line.",
            keyPoints: ["kp 1", "kp 2", "kp 3"],
            learnings: ["lesson a", "lesson b"],
            chapters: [{ title: "Intro", summary: "intro chapter" }],
            conclusion: "Final thought.",
        };
        db.setVideoSummary("vid_long01234", "long", long);
        const video = db.getVideo("vid_long01234");

        expect(video?.summaryLong).toEqual(long);
    });

    it("preserves null summaryLong when the column has never been written", () => {
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({ id: "vid_long_null", channelHandle: "@mkbhd", title: "T" });

        expect(db.getVideo("vid_long_null")?.summaryLong).toBeNull();
    });

    it("re-runs add-videos-summary-long-json migration idempotently", () => {
        const cols = db.getDb().query<{ name: string }, []>("PRAGMA table_info(videos)").all() as Array<{
            name: string;
        }>;
        expect(cols.some((c) => c.name === "summary_long_json")).toBe(true);

        db.initSchemaForTest();
        const cols2 = db.getDb().query<{ name: string }, []>("PRAGMA table_info(videos)").all() as Array<{
            name: string;
        }>;
        expect(cols2.filter((c) => c.name === "summary_long_json").length).toBe(1);
    });

    it("prunes expired binary files and clears database paths", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "youtube-db-prune-"));
        tempDirs.push(tempDir);
        const audioPath = join(tempDir, "old.wav");
        const videoPath = join(tempDir, "old.mp4");
        const thumbPath = join(tempDir, "fresh.jpg");
        writeFileSync(audioPath, "audio");
        writeFileSync(videoPath, "video");
        writeFileSync(thumbPath, "thumb");
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "Video 1" });
        db.setVideoBinaryPath("vid00000001", "audio", audioPath, 5);
        db.setVideoBinaryPath("vid00000001", "video", videoPath, 5);
        db.setVideoBinaryPath("vid00000001", "thumb", thumbPath);
        db.getDb().run(
            "UPDATE videos SET audio_cached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'), video_cached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'), thumb_cached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            ["vid00000001"]
        );

        const result = await db.pruneExpiredBinaries({
            audioOlderThanDays: 7,
            videoOlderThanDays: 7,
            thumbOlderThanDays: 7,
        });
        const video = db.getVideo("vid00000001");

        expect(result).toEqual({ audio: 1, video: 1, thumb: 0 });
        expect(existsSync(audioPath)).toBe(false);
        expect(existsSync(videoPath)).toBe(false);
        expect(existsSync(thumbPath)).toBe(true);
        expect(video?.audioPath).toBeNull();
        expect(video?.audioSizeBytes).toBeNull();
        expect(video?.videoPath).toBeNull();
        expect(video?.videoSizeBytes).toBeNull();
        expect(video?.thumbPath).toBe(thumbPath);
    });
});

describe("YoutubeDatabase transcripts", () => {
    beforeEach(() => {
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "T" });
    });

    it("saves and retrieves a transcript", () => {
        db.saveTranscript({
            videoId: "vid00000001",
            lang: "en",
            source: "captions",
            text: "Hello world from MKBHD",
            segments: [{ start: 0, end: 1, text: "Hello world from MKBHD" }],
            durationSec: 1,
        });
        const transcript = db.getTranscript("vid00000001");

        expect(transcript?.text).toContain("MKBHD");
        expect(transcript?.segments).toEqual([{ start: 0, end: 1, text: "Hello world from MKBHD" }]);
    });

    it("prefers captions over AI by default", () => {
        db.saveTranscript({ videoId: "vid00000001", lang: "en", source: "ai", text: "AI text", segments: [] });
        db.saveTranscript({
            videoId: "vid00000001",
            lang: "en",
            source: "captions",
            text: "Caption text",
            segments: [],
        });
        const transcript = db.getTranscript("vid00000001");

        expect(transcript?.source).toBe("captions");
    });

    it("lists transcripts for a video", () => {
        db.saveTranscript({ videoId: "vid00000001", lang: "en", source: "captions", text: "English", segments: [] });
        db.saveTranscript({ videoId: "vid00000001", lang: "cs", source: "captions", text: "Czech", segments: [] });
        const transcripts = db.listTranscripts("vid00000001");

        expect(transcripts.map((transcript) => transcript.lang)).toEqual(["cs", "en"]);
    });

    it("FTS5 search finds matches", () => {
        db.saveTranscript({
            videoId: "vid00000001",
            lang: "en",
            source: "captions",
            text: "talking about iPhones today",
            segments: [],
        });
        const hits = db.searchTranscripts("iphones");

        expect(hits.length).toBe(1);
        expect(hits[0].videoId).toBe("vid00000001");
    });
});

describe("YoutubeDatabase video metadata search", () => {
    beforeEach(() => {
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({
            id: "vid_phone001",
            channelHandle: "@mkbhd",
            title: "iPhone 16 review",
            description: "A long detailed phone review",
            tags: ["apple", "review"],
            uploadDate: "2026-04-01",
        });
        db.upsertVideo({
            id: "vid_macsoda1",
            channelHandle: "@mkbhd",
            title: "MacBook test",
            description: "Battery and chip review",
            tags: ["macbook", "agentic"],
            uploadDate: "2026-03-01",
        });
    });

    it("matches title via SQL LIKE", () => {
        const hits = db.searchVideos("phone", { fields: ["title"] });

        expect(hits.length).toBe(1);
        expect(hits[0]).toMatchObject({ videoId: "vid_phone001", field: "title" });
    });

    it("matches description with snippet around the hit", () => {
        const hits = db.searchVideos("Battery", { fields: ["description"] });

        expect(hits[0]).toMatchObject({ videoId: "vid_macsoda1", field: "description" });
        expect(hits[0].snippet.toLowerCase()).toContain("battery");
    });

    it("matches tags from tags_json", () => {
        const hits = db.searchVideos("agentic", { fields: ["tags"] });

        expect(hits.length).toBe(1);
        expect(hits[0]).toMatchObject({ videoId: "vid_macsoda1", field: "tags", snippet: "agentic" });
    });

    it("scopes to a channel and respects limit", () => {
        db.upsertChannel({ handle: "@other" });
        db.upsertVideo({ id: "vid_other001", channelHandle: "@other", title: "phone test", description: null });
        const hits = db.searchVideos("phone", { fields: ["title"], channel: "@mkbhd", limit: 1 });

        expect(hits.length).toBe(1);
        expect(hits[0].channelHandle).toBe("@mkbhd");
    });

    it("returns empty for queries with no match", () => {
        const hits = db.searchVideos("nonexistent-zzz", { fields: ["title", "description", "tags"] });

        expect(hits).toEqual([]);
    });
});

describe("YoutubeDatabase QA chunks", () => {
    beforeEach(() => {
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({ id: "vid00000001", channelHandle: "@mkbhd", title: "T" });
    });

    it("upserts and lists chunks in chunk order", () => {
        db.upsertQaChunk({ videoId: "vid00000001", chunkIdx: 1, text: "Second", embedderModel: "test-model" });
        db.upsertQaChunk({
            videoId: "vid00000001",
            chunkIdx: 0,
            text: "First",
            startSec: 0,
            endSec: 10,
            embedderModel: "test-model",
        });
        const chunks = db.listQaChunks("vid00000001", "test-model");

        expect(chunks.map((chunk) => chunk.text)).toEqual(["First", "Second"]);
        expect(chunks[0].startSec).toBe(0);
        expect(chunks[0].endSec).toBe(10);
    });

    it("round-trips Float32 embeddings", () => {
        db.upsertQaChunk({
            videoId: "vid00000001",
            chunkIdx: 0,
            text: "Embedded",
            embedding: new Float32Array([0.25, 0.5, 0.75]),
            embedderModel: "test-model",
        });
        const [chunk] = db.listQaChunks("vid00000001", "test-model");

        expect(chunk.embedding).toBeInstanceOf(Float32Array);
        expect(Array.from(chunk.embedding ?? [])).toEqual([0.25, 0.5, 0.75]);
        expect(chunk.embeddingDims).toBe(3);
    });

    it("updates an existing model chunk and reports chunk presence", () => {
        db.upsertQaChunk({ videoId: "vid00000001", chunkIdx: 0, text: "Old", embedderModel: "test-model" });
        db.upsertQaChunk({ videoId: "vid00000001", chunkIdx: 0, text: "New", embedderModel: "test-model" });
        const chunks = db.listQaChunks("vid00000001", "test-model");

        expect(db.hasQaChunks("vid00000001", "test-model")).toBe(true);
        expect(db.hasQaChunks("vid00000001", "missing-model")).toBe(false);
        expect(chunks.length).toBe(1);
        expect(chunks[0].text).toBe("New");
    });
});

describe("YoutubeDatabase jobs", () => {
    it("enqueues and retrieves a pending job", () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata", "captions"] });

        expect(job.id).toBeGreaterThan(0);
        expect(job.status).toBe("pending");
        expect(job.stages).toEqual(["metadata", "captions"]);
        expect(db.getJob(job.id)?.target).toBe("vid00000001");
    });

    it("claims only jobs whose next stage matches the worker stage", () => {
        const discoverThenMetadata = db.enqueueJob({
            targetKind: "channel",
            target: "@mkbhd",
            stages: ["discover", "metadata"],
        });
        const metadataOnly = db.enqueueJob({ targetKind: "video", target: "meta", stages: ["metadata"] });
        const claimed = db.claimNextJob("worker-1", { stage: "metadata" });

        expect(claimed?.id).toBe(metadataOnly.id);
        expect(claimed?.status).toBe("running");
        expect(claimed?.workerId).toBe("worker-1");
        expect(claimed?.claimedAt).toBeString();
        expect(db.getJob(discoverThenMetadata.id)?.status).toBe("pending");
    });

    it("updates running jobs through completion", () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });
        const claimed = db.claimNextJob("worker-1");

        db.updateJob(claimed?.id ?? job.id, { currentStage: "metadata", progress: 0.5, progressMessage: "half" });
        expect(db.getJob(job.id)?.progress).toBe(0.5);

        db.updateJob(job.id, { status: "completed", progress: 1 });
        const completed = db.getJob(job.id);

        expect(completed?.status).toBe("completed");
        expect(completed?.completedAt).toBeString();
    });

    it("rejects invalid job state transitions", () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });

        expect(() => db.updateJob(job.id, { status: "completed" })).toThrow(
            "invalid job transition pending -> completed"
        );
    });

    it("cancels pending and running jobs", () => {
        const pending = db.enqueueJob({ targetKind: "video", target: "pending", stages: ["metadata"] });
        db.enqueueJob({ targetKind: "video", target: "running", stages: ["metadata"] });
        const running = db.claimNextJob("worker-1");

        db.cancelJob(pending.id);
        db.cancelJob(running?.id ?? 0);

        expect(db.getJob(pending.id)?.status).toBe("cancelled");
        expect(db.getJob(running?.id ?? 0)?.status).toBe("cancelled");
    });

    it("requeues interrupted running jobs", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "first", stages: ["metadata"] });
        const second = db.enqueueJob({ targetKind: "video", target: "second", stages: ["metadata"] });
        db.claimNextJob("worker-1");
        db.claimNextJob("worker-2");
        db.updateJob(first.id, { currentStage: "metadata", progress: 0.25, progressMessage: "working" });
        const count = db.markInterruptedJobsForRequeue();

        expect(count).toBe(2);
        expect(db.getJob(first.id)?.status).toBe("pending");
        expect(db.getJob(first.id)?.workerId).toBeNull();
        expect(db.getJob(first.id)?.progress).toBe(0);
        expect(db.getJob(second.id)?.status).toBe("pending");
    });

    it("lists jobs by filters", () => {
        const parent = db.enqueueJob({ targetKind: "channel", target: "@mkbhd", stages: ["discover"] });
        db.enqueueJob({ targetKind: "video", target: "child", stages: ["metadata"], parentJobId: parent.id });
        db.enqueueJob({ targetKind: "video", target: "other", stages: ["metadata"] });

        const children = db.listJobs({ parentJobId: parent.id });
        const videos = db.listJobs({ targetKind: "video", limit: 2 });

        expect(children.map((job) => job.target)).toEqual(["child"]);
        expect(videos.length).toBe(2);
    });
});

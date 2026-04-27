import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
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
        const tables = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE name='transcripts_fts'")
            .all() as Array<{ name: string }>;
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
        db.upsertVideo({ id: "vid00000003", channelHandle: "@mkbhd", title: "Short", uploadDate: "2026-05-01", isShort: true });
        db.upsertVideo({ id: "vid00000004", channelHandle: "@mkbhd", title: "Live", uploadDate: "2026-06-01", isLive: true });
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
        db.saveTranscript({ videoId: "vid00000001", lang: "en", source: "captions", text: "Caption text", segments: [] });
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
        db.saveTranscript({ videoId: "vid00000001", lang: "en", source: "captions", text: "talking about iPhones today", segments: [] });
        const hits = db.searchTranscripts("iphones");

        expect(hits.length).toBe(1);
        expect(hits[0].videoId).toBe("vid00000001");
    });
});

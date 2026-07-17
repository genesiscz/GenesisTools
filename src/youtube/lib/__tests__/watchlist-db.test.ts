import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "One" });
    db.upsertVideo({ id: "vid00000002", channelHandle: "@chan", title: "Two" });
    db.saveTranscript({
        videoId: "vid00000001",
        lang: "en",
        source: "captions",
        text: "hello",
        segments: [{ text: "hello", start: 0, end: 1 }],
    });
});

afterEach(() => {
    db.close();
});

describe("watchlist + gating readers", () => {
    it("watchlist add/remove is idempotent and user-scoped", () => {
        db.addWatchlistChannel(1, "@chan");
        db.addWatchlistChannel(1, "@chan");
        db.addWatchlistChannel(2, "@chan");

        expect(db.listWatchlist(1)).toHaveLength(1);
        expect(db.removeWatchlistChannel(1, "@chan")).toBe(true);
        expect(db.removeWatchlistChannel(1, "@chan")).toBe(false);
        expect(db.listWatchlist(2)).toHaveLength(1);
    });

    it("hasWatched + listWatchedVideoIdsSince read video_watchers", () => {
        db.recordVideoWatch({ userId: 1, videoId: "vid00000001" });
        db.recordVideoWatch({ userId: 1, videoId: "vid00000001" });
        db.recordVideoWatch({ userId: 2, videoId: "vid00000002" });

        expect(db.hasWatched(1, "vid00000001")).toBe(true);
        expect(db.hasWatched(1, "vid00000002")).toBe(false);
        expect(db.listWatchedVideoIdsSince(1, "2000-01-01T00:00:00.000Z")).toEqual(["vid00000001"]);
        expect(db.listWatchedVideoIdsSince(1, "2999-01-01T00:00:00.000Z")).toEqual([]);
    });

    it("getVideosByIds hydrates lite records with content flags", () => {
        const lites = db.getVideosByIds(["vid00000001", "vid00000002", "vid_missing"]);

        expect(lites).toHaveLength(2);
        const one = lites.find((lite) => lite.id === "vid00000001");

        expect(one?.hasTranscript).toBe(true);
        expect(one?.hasSummary).toBe(false);
        expect(db.getVideosByIds([])).toEqual([]);
    });

    it("listWatchesByUser returns newest-first watches for one user", () => {
        db.recordVideoWatch({ userId: 1, videoId: "vid00000001" });
        db.recordVideoWatch({ userId: 1, videoId: "vid00000002" });
        db.recordVideoWatch({ userId: 2, videoId: "vid00000001" });

        const watches = db.listWatchesByUser(1);

        expect(watches).toHaveLength(2);
        expect(watches[0].videoId).toBe("vid00000002");
        expect(watches.every((watch) => watch.userId === 1)).toBe(true);
    });

    it("listJobs filters by userId", () => {
        db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["captions"], userId: 1 });
        db.enqueueJob({ targetKind: "video", target: "vid00000002", stages: ["captions"], userId: 2 });

        expect(db.listJobs({ userId: 1 })).toHaveLength(1);
        expect(db.listJobs({})).toHaveLength(2);
    });
});

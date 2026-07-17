import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { buildHistoryEntries, groupHistoryByAction, groupHistoryByVideo } from "@app/youtube/lib/history";

const entries = [
    { ts: "2026-07-15T10:00:00.000Z", action: "watch", videoId: "vidA" },
    { ts: "2026-07-16T09:00:00.000Z", action: "summary:view", videoId: "vidA" },
    { ts: "2026-07-14T08:00:00.000Z", action: "watch", videoId: "vidB" },
    { ts: "2026-07-17T07:00:00.000Z", action: "ask", videoId: "vidA" },
    { ts: "2026-07-13T06:00:00.000Z", action: "watch", videoId: "vidA" },
];

describe("history groupers (pure)", () => {
    it("groups by video, newest activity first, with per-action counts", () => {
        const groups = groupHistoryByVideo(entries);

        expect(groups.map((group) => group.videoId)).toEqual(["vidA", "vidB"]);
        expect(groups[0].lastTs).toBe("2026-07-17T07:00:00.000Z");
        expect(groups[0].counts).toEqual({ watch: 2, "summary:view": 1, ask: 1 });
    });

    it("groups by action, most frequent first", () => {
        const groups = groupHistoryByAction(entries);

        expect(groups.map((group) => `${group.action}=${group.count}`)).toEqual(["watch=3", "summary:view=1", "ask=1"]);
    });
});

describe("buildHistoryEntries", () => {
    let db: YoutubeDatabase;

    beforeEach(() => {
        db = new YoutubeDatabase(":memory:");
        db.upsertChannel({ handle: "@chan" });
        db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "One" });
    });

    afterEach(() => {
        db.close();
    });

    it("merges watches, view logs, asks, and user jobs, newest first", () => {
        const user = db.createUser({ email: "h@example.com", passwordHash: "h", apiToken: "ytu_h" });
        db.recordVideoWatch({ userId: user.id, videoId: "vid00000001" });
        db.recordVideoLog({ kind: "transcript:view", userId: user.id, videoId: "vid00000001", meta: null });
        db.insertQaHistory({
            userId: user.id,
            videoId: "vid00000001",
            question: "q",
            answer: "a",
            citations: [],
            creditsSpent: 5,
        });
        db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["captions"], userId: user.id });
        db.recordVideoWatch({ userId: 999, videoId: "vid00000001" });

        const merged = buildHistoryEntries(db, user.id);
        const actions = merged.map((entry) => entry.action);

        expect(actions).toContain("watch");
        expect(actions).toContain("transcript:view");
        expect(actions).toContain("ask");
        expect(actions).toContain("job:captions");
        expect(merged).toHaveLength(4);
        const sorted = [...merged].sort((a, b) => b.ts.localeCompare(a.ts));

        expect(merged).toEqual(sorted);
    });
});

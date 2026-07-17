import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("audit tables", () => {
    it("records and lists video watchers (userId nullable)", () => {
        db.recordVideoWatch({ userId: null, videoId: "vid00000001" });
        db.recordVideoWatch({ userId: 7, videoId: "vid00000001" });
        const rows = db.listVideoWatchers("vid00000001");

        expect(rows).toHaveLength(2);
        expect(rows[0].userId).toBe(7);
        expect(rows[1].userId).toBeNull();
        expect(rows[0].createdAt.endsWith("Z")).toBe(true);
    });

    it("records video logs with meta round-trip and kind filter", () => {
        db.recordVideoLog({ kind: "insights:view", userId: 3, videoId: "vid00000001", meta: { mode: "timestamped", lang: "en" } });
        db.recordVideoLog({ kind: "comments:view", userId: null, videoId: "vid00000002", meta: null });
        const forVideo = db.listVideoLogs({ videoId: "vid00000001" });

        expect(forVideo).toHaveLength(1);
        expect(forVideo[0].kind).toBe("insights:view");
        expect(forVideo[0].meta).toEqual({ mode: "timestamped", lang: "en" });
        expect(db.listVideoLogs({ userId: 3 })).toHaveLength(1);
        expect(db.listVideoLogs()).toHaveLength(2);
    });

    it("rejects unknown video_logs kinds via CHECK", () => {
        expect(() =>
            db.recordVideoLog({ kind: "bogus:view" as never, userId: null, videoId: "vid00000001" })
        ).toThrow();
    });

    it("records ai calls with defaults and filters", () => {
        db.recordAiCall({ provider: "xai", model: "grok-4", action: "summarize:long", videoId: "vid00000001", userId: 3, inputTokens: 1200, outputTokens: 300, costUsd: 0.0042, jobId: 11 });
        db.recordAiCall({ provider: "deepgram", model: "nova-3", action: "transcribe:ai" });
        const forUser = db.listAiCalls({ userId: 3 });

        expect(forUser).toHaveLength(1);
        expect(forUser[0].costUsd).toBeCloseTo(0.0042);
        expect(forUser[0].creditsCharged).toBeNull();
        const bare = db.listAiCalls({ videoId: undefined });

        expect(bare).toHaveLength(2);
        expect(bare.find((row) => row.provider === "deepgram")?.inputTokens).toBe(0);
        expect(db.listAiCalls({ jobId: 11 })).toHaveLength(1);
    });
});

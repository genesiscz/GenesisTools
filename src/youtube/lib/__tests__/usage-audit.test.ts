import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { withJobActivity } from "@app/youtube/lib/job-activity";
import { withRequestContext } from "@app/youtube/lib/request-context";
import { recordYoutubeUsage } from "@app/youtube/lib/usage";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("recordYoutubeUsage → ai_calls", () => {
    it("writes an ai_calls row with request-context attribution", async () => {
        await withRequestContext({ userId: 42, db }, async () => {
            await recordYoutubeUsage({
                action: "qa:ask",
                provider: "xai",
                model: "grok-4",
                videoId: "vid00000001",
                scope: "vid00000001",
            });
        });
        const calls = db.listAiCalls({ userId: 42 });

        expect(calls).toHaveLength(1);
        expect(calls[0].action).toBe("qa:ask");
        expect(calls[0].videoId).toBe("vid00000001");
        expect(calls[0].jobId).toBeNull();
        expect(calls[0].inputTokens).toBe(0);
    });

    it("prefers job-context attribution (jobId + job owner) over request context", async () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000002", stages: ["summarize"], userId: 7 });

        await withRequestContext({ userId: 99, db }, async () => {
            await withJobActivity({ jobId: job.id, stage: "summarize", db, userId: 7 }, async () => {
                await recordYoutubeUsage({
                    action: "summarize:long",
                    provider: "xai",
                    model: "grok-4",
                    videoId: "vid00000002",
                });
            });
        });
        const calls = db.listAiCalls({ jobId: job.id });

        expect(calls).toHaveLength(1);
        expect(calls[0].userId).toBe(7);
    });

    it("does not throw without any context (CLI path) and writes nothing", async () => {
        await recordYoutubeUsage({ action: "transcribe:ai", provider: "deepgram", model: "nova-3" });
        expect(db.listAiCalls()).toHaveLength(0);
    });
});

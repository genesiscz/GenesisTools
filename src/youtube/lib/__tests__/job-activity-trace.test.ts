import { describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { summarizeJson, traceJobExternalCall, withJobActivity } from "@app/youtube/lib/job-activity";

describe("traceJobExternalCall", () => {
    it("records api activity when a job context is active", async () => {
        const db = new YoutubeDatabase(":memory:");
        const { job } = db.enqueueJob({
            targetKind: "channel",
            target: "@mkbhd",
            stages: ["discover"],
        });

        const result = await withJobActivity({ jobId: job.id, stage: "discover", db }, () =>
            traceJobExternalCall(
                {
                    action: "yt-dlp:list-channel",
                    provider: "yt-dlp",
                    model: "@mkbhd",
                    prompt: summarizeJson({ handle: "@mkbhd" }),
                    summarize: (value) => summarizeJson({ videos: value.length }),
                },
                async () => [{ id: "abc" }, { id: "def" }]
            )
        );

        expect(result).toHaveLength(2);
        const activity = db.listJobActivity(job.id);
        expect(activity).toHaveLength(1);
        expect(activity[0]).toMatchObject({
            kind: "api",
            action: "yt-dlp:list-channel",
            provider: "yt-dlp",
            model: "@mkbhd",
            stage: "discover",
            error: null,
        });
        expect(activity[0]?.response).toContain('"videos":2');
        expect(activity[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records failed api calls without swallowing the error", async () => {
        const db = new YoutubeDatabase(":memory:");
        const { job } = db.enqueueJob({
            targetKind: "video",
            target: "abc123def45",
            stages: ["metadata"],
        });

        await expect(
            withJobActivity({ jobId: job.id, stage: "metadata", db }, () =>
                traceJobExternalCall(
                    {
                        action: "yt-dlp:dump-metadata",
                        provider: "yt-dlp",
                        model: "abc123def45",
                        prompt: "abc123def45",
                    },
                    async () => {
                        throw new Error("yt-dlp boom");
                    }
                )
            )
        ).rejects.toThrow("yt-dlp boom");

        const activity = db.listJobActivity(job.id);
        expect(activity).toHaveLength(1);
        expect(activity[0]?.error).toBe("yt-dlp boom");
        expect(activity[0]?.kind).toBe("api");
    });

    it("no-ops recording when no job context is active", async () => {
        const value = await traceJobExternalCall({ action: "yt-dlp:list-channel", provider: "yt-dlp" }, async () => 42);
        expect(value).toBe(42);
    });
});

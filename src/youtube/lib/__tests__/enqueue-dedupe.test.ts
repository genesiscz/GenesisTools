import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("enqueueJob dedupe", () => {
    it("returns the same job id with reused=true for an identical second enqueue", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });
        const second = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });

        expect(first.reused).toBe(false);
        expect(second.reused).toBe(true);
        expect(second.job.id).toBe(first.job.id);
        expect(db.listJobs({ targetKind: "video", target: "vid00000001" })).toHaveLength(1);
    });

    it("skips reuse and inserts a fresh job when force is set", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });
        const second = db.enqueueJob({
            targetKind: "video",
            target: "vid00000001",
            stages: ["metadata"],
            force: true,
        });

        expect(second.reused).toBe(false);
        expect(second.job.id).not.toBe(first.job.id);
    });

    it("does not reuse a job whose identical fingerprint already completed", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });
        db.claimNextJob("worker-1");
        db.updateJob(first.job.id, { status: "completed" });

        const second = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });

        expect(second.reused).toBe(false);
        expect(second.job.id).not.toBe(first.job.id);
    });
});

describe("claimNextJob priority ordering", () => {
    it("prefers higher priority over lower id when no stage filter is given", () => {
        const low = db.enqueueJob({ targetKind: "video", target: "low-priority", stages: ["metadata"] });
        const high = db.enqueueJob({
            targetKind: "video",
            target: "high-priority",
            stages: ["summarize"],
        });

        expect(low.job.priority).toBeLessThan(high.job.priority);

        const claimed = db.claimNextJob("worker-1");

        expect(claimed?.id).toBe(high.job.id);
    });

    it("falls back to lower id when priorities are equal", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "first", stages: ["metadata"] });
        const second = db.enqueueJob({ targetKind: "video", target: "second", stages: ["metadata"] });

        expect(first.job.priority).toBe(second.job.priority);

        const claimed = db.claimNextJob("worker-1");

        expect(claimed?.id).toBe(first.job.id);
    });
});

describe("getJobQueuePosition", () => {
    it("is priority-aware, not just id-ordered", () => {
        const first = db.enqueueJob({ targetKind: "video", target: "first", stages: ["metadata"] });
        const second = db.enqueueJob({ targetKind: "video", target: "second", stages: ["metadata"] });
        const urgent = db.enqueueJob({
            targetKind: "video",
            target: "urgent",
            stages: ["summarize"],
        });

        expect(db.getJobQueuePosition(urgent.job.id)).toBe(1);
        expect(db.getJobQueuePosition(first.job.id)).toBe(2);
        expect(db.getJobQueuePosition(second.job.id)).toBe(3);
    });

    it("returns null for jobs that are not pending or do not exist", () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["metadata"] });
        db.claimNextJob("worker-1");

        expect(db.getJobQueuePosition(job.job.id)).toBeNull();
        expect(db.getJobQueuePosition(999999)).toBeNull();
    });
});

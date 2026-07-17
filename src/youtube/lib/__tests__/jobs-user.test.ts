import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("jobs user attribution", () => {
    it("stores and returns userId on enqueue", () => {
        const owned = db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["captions"], userId: 42 });
        const anonymous = db.enqueueJob({ targetKind: "video", target: "vid00000002", stages: ["captions"] });

        expect(owned.userId).toBe(42);
        expect(anonymous.userId).toBeNull();
        expect(db.getJob(owned.id)?.userId).toBe(42);
    });

    it("keeps userId across claim and requeue", () => {
        const job = db.enqueueJob({ targetKind: "video", target: "vid00000003", stages: ["captions"], userId: 7 });
        const claimed = db.claimNextJob("worker-1");

        expect(claimed?.id).toBe(job.id);
        expect(claimed?.userId).toBe(7);

        db.markInterruptedJobsForRequeue();
        expect(db.getJob(job.id)?.userId).toBe(7);
    });
});

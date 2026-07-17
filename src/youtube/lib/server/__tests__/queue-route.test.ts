import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handlePipelineRoute } from "@app/youtube/lib/server/routes/pipeline";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-queue-route-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/v1/jobs/queue", () => {
    it("aggregates queued/running per stage with oldest age", async () => {
        db.enqueueJob({ targetKind: "video", target: "vid00000001", stages: ["captions", "summarize"] });
        db.enqueueJob({ targetKind: "video", target: "vid00000002", stages: ["captions"] });
        db.enqueueJob({ targetKind: "video", target: "vid00000003", stages: ["summarize"] });
        const claimed = db.claimNextJob("worker-1");

        expect(claimed).not.toBeNull();

        const url = new URL("http://localhost/api/v1/jobs/queue");
        const res = await handlePipelineRoute(new Request(url), url, yt);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { queue: { queued: number; running: number; perStage: Record<string, { queued: number; running: number }>; oldestQueuedAgeSec: number | null } };

        expect(body.queue.queued).toBe(2);
        expect(body.queue.running).toBe(1);
        expect(body.queue.perStage.captions).toEqual({ queued: 1, running: 1 });
        expect(body.queue.perStage.summarize).toEqual({ queued: 1, running: 0 });
        expect(body.queue.oldestQueuedAgeSec).not.toBeNull();
        expect(body.queue.oldestQueuedAgeSec ?? 0).toBeGreaterThanOrEqual(0);
    });

    it("returns zeros on an empty queue", async () => {
        const url = new URL("http://localhost/api/v1/jobs/queue");
        const res = await handlePipelineRoute(new Request(url), url, yt);
        const body = (await res.json()) as { queue: { queued: number; running: number; oldestQueuedAgeSec: number | null } };

        expect(res.status).toBe(200);
        expect(body.queue.queued).toBe(0);
        expect(body.queue.running).toBe(0);
        expect(body.queue.oldestQueuedAgeSec).toBeNull();
    });
});

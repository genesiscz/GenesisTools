import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { JobStage } from "@app/youtube/lib/jobs.types";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap } from "@app/youtube/lib/pipeline.types";

describe("Pipeline", () => {
    it("enqueues jobs and emits creation events", async () => {
        const { db, config, dir } = await makeFixture();
        const pipeline = new Pipeline(db, config, { handlers: makeHandlers() });
        const events: unknown[] = [];
        const off = pipeline.on("job:created", (event) => events.push(event));

        try {
            const job = pipeline.enqueue({ targetKind: "video", target: "abc123def45", stages: ["metadata"] });

            expect(job.status).toBe("pending");
            expect(events).toEqual([{ type: "job:created", job }]);
            expect(pipeline.getJob(job.id)?.target).toBe("abc123def45");
        } finally {
            off();
            await pipeline.stop();
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("runs claimed jobs through handlers and emits stage/completion events", async () => {
        const { db, config, dir } = await makeFixture();
        await config.update({ concurrency: { download: 1, localTranscribe: 1, cloudTranscribe: 1, summarize: 1 } });
        const handlerCalls: string[] = [];
        const pipeline = new Pipeline(db, config, {
            pollMs: 1,
            handlers: makeHandlers({
                metadata: async (ctx) => {
                    handlerCalls.push(`metadata:${ctx.job.target}`);
                    ctx.onProgress(0.5, "halfway");
                },
            }),
        });
        const events: string[] = [];
        pipeline.on("job:started", () => events.push("job:started"));
        pipeline.on("stage:started", (event) => events.push(`stage:started:${event.stage}`));
        pipeline.on("stage:progress", (event) => events.push(`stage:progress:${event.progress}:${event.message}`));
        pipeline.on("stage:completed", (event) => events.push(`stage:completed:${event.stage}`));
        pipeline.on("job:completed", () => events.push("job:completed"));

        try {
            const job = pipeline.enqueue({ targetKind: "video", target: "abc123def45", stages: ["metadata"] });
            await pipeline.start();
            await waitFor(() => pipeline.getJob(job.id)?.status === "completed");

            expect(handlerCalls).toEqual(["metadata:abc123def45"]);
            expect(events).toEqual([
                "job:started",
                "stage:started:metadata",
                "stage:progress:0.5:halfway",
                "stage:completed:metadata",
                "job:completed",
            ]);
            expect(pipeline.getJob(job.id)).toMatchObject({ status: "completed", progress: 1, currentStage: null });
        } finally {
            await pipeline.stop();
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("marks failed jobs and emits failure events", async () => {
        const { db, config, dir } = await makeFixture();
        await config.update({ concurrency: { download: 1, localTranscribe: 1, cloudTranscribe: 1, summarize: 1 } });
        const pipeline = new Pipeline(db, config, {
            pollMs: 1,
            handlers: makeHandlers({
                metadata: async () => {
                    throw new Error("boom");
                },
            }),
        });
        const failures: unknown[] = [];
        pipeline.on("job:failed", (event) => failures.push(event));

        try {
            const job = pipeline.enqueue({ targetKind: "video", target: "abc123def45", stages: ["metadata"] });
            await pipeline.start();
            await waitFor(() => pipeline.getJob(job.id)?.status === "failed");

            expect(pipeline.getJob(job.id)).toMatchObject({ status: "failed", error: "boom" });
            expect(failures).toHaveLength(1);
        } finally {
            await pipeline.stop();
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("propagates AbortSignal mid-stage when cancelJob is called on a running job", async () => {
        const { db, config, dir } = await makeFixture();
        await config.update({ concurrency: { download: 1, localTranscribe: 1, cloudTranscribe: 1, summarize: 1 } });
        let observedSignal: AbortSignal | null = null;
        let abortObserved = false;
        const handlers = makeHandlers({
            metadata: async (ctx) => {
                observedSignal = ctx.signal;

                await new Promise<void>((resolve) => {
                    const onAbort = () => {
                        abortObserved = true;
                        resolve();
                    };

                    if (ctx.signal.aborted) {
                        onAbort();
                        return;
                    }

                    ctx.signal.addEventListener("abort", onAbort, { once: true });
                });
            },
        });
        const pipeline = new Pipeline(db, config, { pollMs: 1, handlers });

        try {
            await pipeline.start();
            const job = pipeline.enqueue({ targetKind: "video", target: "live-cancel", stages: ["metadata"] });
            await waitFor(() => observedSignal !== null);
            pipeline.cancelJob(job.id);
            await waitFor(() => abortObserved);

            expect(abortObserved).toBe(true);
            expect(observedSignal!.aborted).toBe(true);
        } finally {
            await pipeline.stop();
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("requeues interrupted jobs on start and can cancel jobs", async () => {
        const { db, config, dir } = await makeFixture();
        await config.update({ concurrency: { download: 1, localTranscribe: 1, cloudTranscribe: 1, summarize: 1 } });
        const pipeline = new Pipeline(db, config, { pollMs: 1, handlers: makeHandlers() });
        const cancelled: unknown[] = [];
        pipeline.on("job:cancelled", (event) => cancelled.push(event));

        try {
            const interrupted = db.enqueueJob({ targetKind: "video", target: "interrupted", stages: ["metadata"] });
            db.claimNextJob("old-worker");
            const cancelledJob = pipeline.enqueue({ targetKind: "video", target: "cancelled", stages: ["metadata"] });
            pipeline.cancelJob(cancelledJob.id);
            await pipeline.start();
            await waitFor(() => pipeline.getJob(interrupted.id)?.status === "completed");

            expect(pipeline.getJob(cancelledJob.id)?.status).toBe("cancelled");
            expect(cancelled).toEqual([{ type: "job:cancelled", jobId: cancelledJob.id }]);
            expect(pipeline.listJobs({ status: "completed", limit: 10 }).map((job) => job.id)).toContain(
                interrupted.id
            );
        } finally {
            await pipeline.stop();
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

async function makeFixture(): Promise<{ db: YoutubeDatabase; config: YoutubeConfig; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-pipeline-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });

    return { db, config, dir };
}

function makeHandlers(overrides: Partial<PipelineHandlerMap> = {}): PipelineHandlerMap {
    const stages: JobStage[] = ["discover", "metadata", "captions", "audio", "transcribe", "summarize"];
    const handlers = Object.fromEntries(
        stages.map((stage) => [stage, async () => {}])
    ) as unknown as PipelineHandlerMap;

    return { ...handlers, ...overrides };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("timed out waiting for predicate");
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

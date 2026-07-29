import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { JOB_STAGES } from "@app/youtube/lib/jobs.types";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap } from "@app/youtube/lib/pipeline.types";
import type { IndexOpts } from "@app/youtube/lib/qa.types";
import { QueueService, toJobStages } from "@app/youtube/lib/queue";
import { withRequestContext } from "@app/youtube/lib/request-context";
import { Youtube } from "@app/youtube/lib/youtube";

describe("QueueService", () => {
    it("normalises a channel URL before inferring its target kind", async () => {
        const fixture = await makeFixture();

        try {
            const result = fixture.queue.enqueue({
                target: "https://youtube.com/@bridgemindai?si=G5OYF1KBX8tSz7Zk",
                stages: ["discover", "metadata"],
            });

            expect(result.job).toMatchObject({
                targetKind: "channel",
                target: "@bridgemindai",
            });
            expect(fixture.db.listJobs()).toHaveLength(1);
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("normalises a watch URL to its bare video id", async () => {
        const fixture = await makeFixture();

        try {
            const result = fixture.queue.enqueue({
                target: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                stages: ["metadata"],
            });

            expect(result.job).toMatchObject({
                targetKind: "video",
                target: "dQw4w9WgXcQ",
            });
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("validates every declared pipeline stage", () => {
        expect(toJobStages(["qaIndex"])).toEqual(["qaIndex"]);
        expect(toJobStages(["qa"])).toEqual(["qa"]);
        expect(toJobStages(["reportSynthesize"])).toEqual(["reportSynthesize"]);
        expect(() => toJobStages(["nope"])).toThrow("Unknown pipeline stage: nope");
    });

    it("lists queued jobs and reports queue stats", async () => {
        const fixture = await makeFixture();

        try {
            fixture.queue.enqueue({ target: "first-video", stages: ["metadata"] });
            fixture.queue.enqueue({ target: "second-video", stages: ["metadata"] });

            expect(fixture.queue.list({ actor: { kind: "operator" } })).toHaveLength(2);
            expect(fixture.queue.stats({ kind: "operator" })).toMatchObject({ queued: 2, running: 0 });
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("redacts sensitive API params only when requested", async () => {
        const fixture = await makeFixture();

        try {
            fixture.pipeline.enqueue({
                targetKind: "video",
                target: "sensitive-job",
                stages: ["qa"],
                params: {
                    holdId: 12,
                    creditCost: 4,
                    question: "private question",
                    presetInstructions: "private instructions",
                    language: "en",
                },
            });

            expect(fixture.queue.list({ actor: { kind: "operator" } })[0]?.params).toEqual({
                holdId: 12,
                creditCost: 4,
                question: "private question",
                presetInstructions: "private instructions",
                language: "en",
            });
            expect(fixture.queue.list({ redact: true, actor: { kind: "operator" } })[0]?.params).toEqual({
                language: "en",
            });
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("strips server-owned params before enqueue", async () => {
        const fixture = await makeFixture();

        try {
            const result = fixture.queue.enqueue({
                target: "sanitised-job",
                stages: ["qa"],
                params: {
                    holdId: 12,
                    creditCost: 4,
                    question: "kept for the worker",
                },
            });

            expect(result.job?.params).toEqual({ question: "kept for the worker" });
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("owns a job by the ambient request user when the caller passes none", async () => {
        const fixture = await makeFixture();

        try {
            const owned = await withRequestContext({ db: fixture.db, userId: 42 }, async () =>
                fixture.queue.enqueue({ target: "ambient-owner", stages: ["metadata"] })
            );

            expect(owned.job?.userId).toBe(42);
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("prefers an explicit userId over the ambient one", async () => {
        const fixture = await makeFixture();

        try {
            const owned = await withRequestContext({ db: fixture.db, userId: 42 }, async () =>
                fixture.queue.enqueue({ target: "explicit-owner", stages: ["metadata"], userId: 7 })
            );

            expect(owned.job?.userId).toBe(7);
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("still enqueues, unowned, when there is no user anywhere in scope", async () => {
        const fixture = await makeFixture();

        try {
            const result = fixture.queue.enqueue({ target: "unowned", stages: ["metadata"] });

            expect(result.job?.userId).toBeNull();
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("forwards queued channel sync options through the discover stage", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-queue-discover-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });
        const received: Array<{ limit?: number; includeShorts?: boolean }> = [];
        const yt = new Youtube({
            baseDir: dir,
            db,
            config,
            deps: {
                listChannelVideos: async (opts) => {
                    received.push({
                        limit: opts.limit,
                        includeShorts: opts.includeShorts,
                    });

                    return [];
                },
            },
        });

        try {
            const job = requireJob(
                yt.queue.enqueue({
                    target: "@queued-options",
                    stages: ["discover", "metadata"],
                    params: {
                        limit: 100,
                        includeShorts: true,
                    },
                }).job
            );
            await yt.pipeline.start();
            await yt.queue.waitForJob(job.id, { actor: { kind: "operator" }, timeoutMs: 1_000 });

            expect(received).toEqual([
                {
                    limit: 100,
                    includeShorts: true,
                },
            ]);
        } finally {
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("validates and forwards qaIndex options while reporting progress", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-queue-qa-index-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });
        const received: IndexOpts[] = [];
        const progress: number[] = [];
        const yt = new Youtube({ baseDir: dir, db, config });
        yt.qa.index = async (opts) => {
            received.push(opts);

            return { indexed: 1, modelId: opts.model ?? "default" };
        };
        const off = yt.pipeline.on("stage:progress", (event) => {
            if (event.stage === "qaIndex") {
                progress.push(event.progress);
            }
        });

        try {
            const valid = requireJob(
                yt.queue.enqueue({
                    target: "abc123def45",
                    stages: ["qaIndex"],
                    params: {
                        sources: ["transcript", "comments"],
                        forceReindex: true,
                        provider: "ollama",
                        model: "custom-embedder",
                    },
                }).job
            );
            const invalid = requireJob(
                yt.queue.enqueue({
                    target: "def123abc45",
                    stages: ["qaIndex"],
                    params: {
                        sources: ["transcript", "invalid"],
                        forceReindex: "yes",
                        provider: 42,
                        model: false,
                    },
                }).job
            );
            await yt.pipeline.start();
            await yt.queue.waitForJob(valid.id, { actor: { kind: "operator" }, timeoutMs: 1_000 });
            await yt.queue.waitForJob(invalid.id, { actor: { kind: "operator" }, timeoutMs: 1_000 });

            expect(received[0]).toMatchObject({
                videoId: "abc123def45",
                sources: ["transcript", "comments"],
                forceReindex: true,
                provider: "ollama",
                model: "custom-embedder",
            });
            expect(received[0].signal).toBeInstanceOf(AbortSignal);
            expect(received[1].videoId).toBe("def123abc45");
            expect(received[1].sources).toBeUndefined();
            expect(received[1].forceReindex).toBeUndefined();
            expect(received[1].provider).toBeUndefined();
            expect(received[1].model).toBeUndefined();
            expect(progress.some((value) => value > 0)).toBe(true);
        } finally {
            off();
            await yt.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("emits status changes and completes when watched jobs are final", async () => {
        const fixture = await makeFixture();

        try {
            const job = requireJob(
                fixture.queue.enqueue({
                    target: "watched-job",
                    stages: ["metadata"],
                }).job
            );
            const watcher = fixture.queue.watch({
                actor: { kind: "operator" },
                jobIds: [job.id],
                intervalMs: 20,
                timeoutMs: 500,
            });
            const seen = await watcher.next();
            expect(seen.value).toMatchObject({ type: "job:seen", job: { id: job.id } });

            fixture.db.claimNextJob("queue-test-worker");
            fixture.db.updateJob(job.id, { status: "completed" });

            const status = await watcher.next();
            expect(status.value).toMatchObject({
                type: "job:status",
                jobId: job.id,
                from: "pending",
                to: "completed",
            });

            const done = await watcher.next();
            expect(done.value).toEqual({
                type: "watch:done",
                at: expect.any(String),
                jobIds: [job.id],
                reason: "complete",
            });
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("emits terminal status changes when watching all active jobs", async () => {
        const fixture = await makeFixture();

        try {
            const job = requireJob(
                fixture.queue.enqueue({
                    target: "all-jobs-watch",
                    stages: ["metadata"],
                }).job
            );
            const watcher = fixture.queue.watch({ actor: { kind: "operator" }, intervalMs: 20, timeoutMs: 500 });
            const seen = await watcher.next();
            expect(seen.value).toMatchObject({ type: "job:seen", job: { id: job.id } });

            fixture.db.claimNextJob("all-jobs-watch-worker");
            fixture.db.updateJob(job.id, { status: "completed" });

            const status = await watcher.next();
            expect(status.value).toMatchObject({
                type: "job:status",
                jobId: job.id,
                from: "pending",
                to: "completed",
            });

            await watcher.return(undefined);
        } finally {
            await disposeFixture(fixture);
        }
    });

    it("discovers child jobs created after watching starts", async () => {
        const fixture = await makeFixture();
        const abortController = new AbortController();

        try {
            const parent = requireJob(
                fixture.queue.enqueue({
                    target: "@parent",
                    stages: ["discover", "metadata"],
                }).job
            );
            const watcher = fixture.queue.watch({
                actor: { kind: "operator" },
                jobIds: [parent.id],
                followChildren: true,
                intervalMs: 20,
                timeoutMs: 500,
                signal: abortController.signal,
            });
            const parentSeen = await watcher.next();
            expect(parentSeen.value).toMatchObject({ type: "job:seen", job: { id: parent.id } });

            const child = fixture.db.enqueueJob({
                targetKind: "video",
                target: "child-video",
                stages: ["metadata"],
                parentJobId: parent.id,
            }).job;
            const childSeen = await watcher.next();
            expect(childSeen.value).toMatchObject({ type: "job:seen", job: { id: child.id } });

            abortController.abort();
            const done = await watcher.next();
            expect(done.value).toMatchObject({ type: "watch:done", reason: "aborted" });
        } finally {
            abortController.abort();
            await disposeFixture(fixture);
        }
    });
});

interface QueueFixture {
    config: YoutubeConfig;
    db: YoutubeDatabase;
    dir: string;
    pipeline: Pipeline;
    queue: QueueService;
}

async function makeFixture(): Promise<QueueFixture> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-queue-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    const handlers = Object.fromEntries(
        JOB_STAGES.map((stage) => [stage, async () => {}])
    ) as unknown as PipelineHandlerMap;
    const pipeline = new Pipeline(db, config, { handlers });
    const queue = new QueueService(pipeline, db);

    return { config, db, dir, pipeline, queue };
}

async function disposeFixture(fixture: QueueFixture): Promise<void> {
    await fixture.pipeline.stop();
    fixture.db.close();
    await rm(fixture.dir, { recursive: true, force: true });
}

function requireJob(job: ReturnType<QueueService["enqueue"]>["job"]): NonNullable<typeof job> {
    if (!job) {
        throw new Error("expected enqueue to return a job");
    }

    return job;
}

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";
import type { SummarizeOpts, SummarizeResult } from "@app/youtube/lib/summarize.types";

describe("youtube server foundation", () => {
    it("starts on a random port, serves health, and stops", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const response = await fetch(`http://localhost:${handle.port}/api/v1/healthz`);
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.ok).toBe(true);
            expect(body.version).toBeString();
            expect(response.headers.get("access-control-allow-origin")).toBe("*");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("answers CORS preflight requests", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const response = await fetch(`http://localhost:${handle.port}/api/v1/healthz`, { method: "OPTIONS" });

            expect(response.status).toBe(204);
            expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("adds, lists, and removes channels", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const addResponse = await fetch(`http://localhost:${handle.port}/api/v1/channels`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ handles: ["mkbhd", "@veritasium"] }),
            });
            const addBody = await addResponse.json();

            expect(addResponse.status).toBe(200);
            expect(addBody.added).toEqual(["@mkbhd", "@veritasium"]);

            const listResponse = await fetch(`http://localhost:${handle.port}/api/v1/channels`);
            const listBody = await listResponse.json();

            expect(listBody.channels.map((channel: { handle: string }) => channel.handle)).toEqual([
                "@mkbhd",
                "@veritasium",
            ]);

            const deleteResponse = await fetch(`http://localhost:${handle.port}/api/v1/channels/%40mkbhd`, {
                method: "DELETE",
            });
            const deleteBody = await deleteResponse.json();

            expect(deleteResponse.status).toBe(200);
            expect(deleteBody.removed).toBe("@mkbhd");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("serves videos, transcripts, summaries, and transcript search", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            handle.youtube.db.upsertChannel({ handle: "@mkbhd" });
            handle.youtube.db.upsertVideo({
                id: "abc123def45",
                channelHandle: "@mkbhd",
                title: "Test Video",
                uploadDate: "2026-04-01",
            });
            handle.youtube.db.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "captions",
                text: "hello searchable world",
                segments: [{ text: "hello searchable world", start: 1, end: 3 }],
                durationSec: 3,
            });
            handle.youtube.db.setVideoSummary("abc123def45", "short", "Cached summary");

            const listResponse = await fetch(
                `http://localhost:${handle.port}/api/v1/videos?channel=%40mkbhd&includeShorts=true`
            );
            const listBody = await listResponse.json();

            expect(listResponse.status).toBe(200);
            expect(listBody.videos).toHaveLength(1);

            const showResponse = await fetch(`http://localhost:${handle.port}/api/v1/videos/abc123def45`);
            const showBody = await showResponse.json();

            expect(showResponse.status).toBe(200);
            expect(showBody.video.title).toBe("Test Video");
            expect(showBody.transcripts).toHaveLength(1);

            const transcriptResponse = await fetch(
                `http://localhost:${handle.port}/api/v1/videos/abc123def45/transcript?format=text`
            );

            expect(transcriptResponse.headers.get("content-type")).toContain("text/plain");
            expect(await transcriptResponse.text()).toBe("hello searchable world");

            const summaryResponse = await fetch(`http://localhost:${handle.port}/api/v1/videos/abc123def45/summary`);
            const summaryBody = await summaryResponse.json();

            expect(summaryBody.summary).toBe("Cached summary");

            const searchResponse = await fetch(`http://localhost:${handle.port}/api/v1/videos/search?q=searchable`);
            const searchBody = await searchResponse.json();

            expect(searchResponse.status).toBe(200);
            expect(searchBody.hits[0].videoId).toBe("abc123def45");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("enqueues, lists, reads, and cancels pipeline jobs", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const enqueueResponse = await fetch(`http://localhost:${handle.port}/api/v1/pipeline`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ target: "abc123def45", stages: ["metadata"] }),
            });
            const enqueueBody = await enqueueResponse.json();

            expect(enqueueResponse.status).toBe(200);
            expect(enqueueBody.job.targetKind).toBe("video");

            const id = enqueueBody.job.id;
            const listResponse = await fetch(`http://localhost:${handle.port}/api/v1/jobs?status=pending`);
            const listBody = await listResponse.json();

            expect(listBody.jobs.map((job: { id: number }) => job.id)).toContain(id);

            const showResponse = await fetch(`http://localhost:${handle.port}/api/v1/jobs/${id}`);
            const showBody = await showResponse.json();

            expect(showBody.job.id).toBe(id);

            const cancelResponse = await fetch(`http://localhost:${handle.port}/api/v1/jobs/${id}/cancel`, {
                method: "POST",
            });
            const cancelBody = await cancelResponse.json();

            expect(cancelResponse.status).toBe(200);
            expect(cancelBody.job.status).toBe("cancelled");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("POST /summary with mode=long, tone, format, length passes them through to summarize", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            handle.youtube.db.upsertChannel({ handle: "@mkbhd" });
            handle.youtube.db.upsertVideo({
                id: "abc123def45",
                channelHandle: "@mkbhd",
                title: "Test Video",
                uploadDate: "2026-04-01",
            });
            handle.youtube.db.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "captions",
                text: "hello",
                segments: [{ text: "hello", start: 0, end: 1 }],
                durationSec: 1,
            });

            const captured: SummarizeOpts[] = [];
            handle.youtube.summary.summarize = async (opts: SummarizeOpts): Promise<SummarizeResult> => {
                captured.push(opts);
                return {
                    long: {
                        tldr: "ok",
                        keyPoints: [],
                        learnings: [],
                        chapters: [],
                        conclusion: null,
                    },
                };
            };

            const res = await fetch(`http://localhost:${handle.port}/api/v1/videos/abc123def45/summary`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({
                    mode: "long",
                    tone: "actionable",
                    format: "qa",
                    length: "detailed",
                    provider: "anthropic",
                    model: "claude-haiku-4-5",
                }),
            });
            const body = (await res.json()) as { summary: { tldr: string }; mode: string; jobId: number };

            expect(res.status).toBe(200);
            expect(body.mode).toBe("long");
            expect(body.summary.tldr).toBe("ok");
            expect(typeof body.jobId).toBe("number");
            expect(captured[0]).toMatchObject({
                mode: "long",
                tone: "actionable",
                format: "qa",
                length: "detailed",
            });
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("serves cache stats and config get/patch routes", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            handle.youtube.db.upsertChannel({ handle: "@mkbhd" });
            handle.youtube.db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Test Video" });
            handle.youtube.db.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "captions",
                text: "hello",
                segments: [],
                durationSec: 1,
            });

            const statsResponse = await fetch(`http://localhost:${handle.port}/api/v1/cache/stats`);
            const statsBody = await statsResponse.json();

            expect(statsResponse.status).toBe(200);
            expect(statsBody.channels).toBe(1);
            expect(statsBody.videos).toBe(1);
            expect(statsBody.transcripts).toBe(1);

            const configResponse = await fetch(`http://localhost:${handle.port}/api/v1/config`);
            const configBody = await configResponse.json();

            expect(configResponse.status).toBe(200);
            expect(configBody.config.apiPort).toBe(9876);
            expect(configBody.where).toContain("server.json");

            const patchResponse = await fetch(`http://localhost:${handle.port}/api/v1/config`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ apiPort: 9999 }),
            });
            const patchBody = await patchResponse.json();

            expect(patchResponse.status).toBe(200);
            expect(patchBody.config.apiPort).toBe(9999);

            const pruneResponse = await fetch(`http://localhost:${handle.port}/api/v1/cache/prune`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ dryRun: true }),
            });
            const pruneBody = await pruneResponse.json();

            expect(pruneResponse.status).toBe(200);
            expect(pruneBody.dryRun).toBe(true);
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

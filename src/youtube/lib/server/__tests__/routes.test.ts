import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@app/youtube/lib/server";
import { SafeJSON } from "@genesiscz/utils/json";
import { apiUrl } from "./test-helpers";

describe("youtube server foundation", () => {
    it("starts on a random port, serves health, and stops", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const response = await fetch(apiUrl(handle.port, `/healthz`));
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
            const response = await fetch(apiUrl(handle.port, `/healthz`), { method: "OPTIONS" });

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
            const addResponse = await fetch(apiUrl(handle.port, `/channels`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ handles: ["mkbhd", "@veritasium"] }),
            });
            const addBody = await addResponse.json();

            expect(addResponse.status).toBe(200);
            expect(addBody.added).toEqual(["@mkbhd", "@veritasium"]);

            const listResponse = await fetch(apiUrl(handle.port, `/channels`));
            const listBody = await listResponse.json();

            expect(listBody.channels.map((channel: { handle: string }) => channel.handle)).toEqual([
                "@mkbhd",
                "@veritasium",
            ]);

            const deleteResponse = await fetch(apiUrl(handle.port, `/channels/%40mkbhd`), {
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

    it("GET /channels/:handle ensures and dedupes discover enqueue", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-ensure-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const first = await fetch(apiUrl(handle.port, `/channels/%40opat04`));
            const firstBody = await first.json();

            expect(first.status).toBe(200);
            expect(firstBody.tracked).toBe(true);
            expect(firstBody.channel.handle).toBe("@opat04");
            expect(firstBody.job?.id).toBeNumber();
            expect(firstBody.syncStatus).toBe("queued");
            expect(firstBody.reused).toBe(false);

            const second = await fetch(apiUrl(handle.port, `/channels/%40opat04`));
            const secondBody = await second.json();

            expect(second.status).toBe(200);
            expect(secondBody.job?.id).toBe(firstBody.job.id);
            expect(secondBody.reused).toBe(true);
            expect(secondBody.syncStatus).toBe("queued");
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

            const listResponse = await fetch(apiUrl(handle.port, `/videos?channel=%40mkbhd&includeShorts=true`));
            const listBody = await listResponse.json();

            expect(listResponse.status).toBe(200);
            expect(listBody.videos).toHaveLength(1);

            const showResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45`));
            const showBody = await showResponse.json();

            expect(showResponse.status).toBe(200);
            expect(showBody.video.title).toBe("Test Video");
            expect(showBody.transcripts).toHaveLength(1);

            const transcriptResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/transcript?format=text`));

            expect(transcriptResponse.headers.get("content-type")).toContain("text/plain");
            expect(await transcriptResponse.text()).toBe("hello searchable world");

            const summaryResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/summary`));
            const summaryBody = await summaryResponse.json();

            expect(summaryBody.summary).toBe("Cached summary");

            const searchResponse = await fetch(apiUrl(handle.port, `/videos/search?q=searchable`));
            const searchBody = await searchResponse.json();

            expect(searchResponse.status).toBe(200);
            expect(searchBody.hits[0].videoId).toBe("abc123def45");
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("upserts speaker labels and returns them from the transcript GET", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            handle.youtube.db.upsertChannel({ handle: "@mkbhd" });
            handle.youtube.db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Interview" });
            handle.youtube.db.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "ai",
                text: "hello there",
                segments: [
                    { text: "hello", start: 0, end: 1, speaker: 0 },
                    { text: "there", start: 1, end: 2, speaker: 1 },
                ],
                durationSec: 2,
            });
            handle.youtube.db.createUser({
                email: "speakers@example.com",
                passwordHash: "hash",
                apiToken: "ytu_speakers_test",
            });
            const authHeaders = { "Content-Type": "application/json", Authorization: "Bearer ytu_speakers_test" };

            const unauthedResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/speakers`), {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ speakers: [{ idx: 0, label: "Host" }] }),
            });

            expect(unauthedResponse.status).toBe(401);

            const putResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/speakers`), {
                method: "PUT",
                headers: authHeaders,
                body: SafeJSON.stringify({
                    speakers: [
                        { idx: 0, label: "Host" },
                        { idx: 1, label: "Guest" },
                    ],
                }),
            });
            const putBody = await putResponse.json();

            expect(putResponse.status).toBe(200);
            expect(putBody.speakerLabels).toEqual({ "0": "Host", "1": "Guest" });

            const getResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/transcript`));
            const getBody = await getResponse.json();

            expect(getResponse.status).toBe(200);
            expect(getBody.speakerLabels).toEqual({ "0": "Host", "1": "Guest" });
            expect(getBody.transcript.segments[0].speaker).toBe(0);

            const renameResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/speakers`), {
                method: "PUT",
                headers: authHeaders,
                body: SafeJSON.stringify({ speakers: [{ idx: 1, label: "Expert" }] }),
            });
            const renameBody = await renameResponse.json();

            expect(renameBody.speakerLabels).toEqual({ "0": "Host", "1": "Expert" });

            const badResponse = await fetch(apiUrl(handle.port, `/videos/abc123def45/speakers`), {
                method: "PUT",
                headers: authHeaders,
                body: SafeJSON.stringify({ speakers: [{ idx: -1, label: "" }] }),
            });

            expect(badResponse.status).toBe(400);
        } finally {
            await handle.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("enqueues, lists, reads, and cancels pipeline jobs", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-routes-"));
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const enqueueResponse = await fetch(apiUrl(handle.port, `/pipeline`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ target: "abc123def45", stages: ["metadata"] }),
            });
            const enqueueBody = await enqueueResponse.json();

            expect(enqueueResponse.status).toBe(200);
            expect(enqueueBody.job.targetKind).toBe("video");

            const id = enqueueBody.job.id;
            const listResponse = await fetch(apiUrl(handle.port, `/jobs?status=pending`));
            const listBody = await listResponse.json();

            expect(listBody.jobs.map((job: { id: number }) => job.id)).toContain(id);

            const showResponse = await fetch(apiUrl(handle.port, `/jobs/${id}`));
            const showBody = await showResponse.json();

            expect(showBody.job.id).toBe(id);

            const cancelResponse = await fetch(apiUrl(handle.port, `/jobs/${id}/cancel`), {
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

    it("POST /summary with mode=long enqueues a high-priority summarize job with params", async () => {
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

            const user = handle.youtube.db.createUser({
                email: "summary-enqueue@example.com",
                passwordHash: "x",
                apiToken: "ytu_summary_enqueue",
            });
            handle.youtube.db.grantCredits(user.id, 500, "dev-topup");

            const summaryBody = {
                mode: "long",
                tone: "actionable",
                format: "qa",
                length: "detailed",
                provider: "anthropic",
                model: "claude-haiku-4-5",
            };

            const res = await fetch(apiUrl(handle.port, `/videos/abc123def45/summary`), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer ytu_summary_enqueue",
                },
                body: SafeJSON.stringify(summaryBody),
            });
            const body = (await res.json()) as {
                jobId: number;
                queuePosition: number | null;
                status: string;
                priority: number;
                reused: boolean;
                summary?: unknown;
            };

            expect(res.status).toBe(200);
            expect(body.summary).toBeUndefined();
            expect(typeof body.jobId).toBe("number");
            expect(body.status).toBe("pending");
            expect(body.priority).toBe(100);
            expect(body.reused).toBe(false);

            const job = handle.youtube.db.getJob(body.jobId);
            expect(job?.stages).toContain("summarize");
            expect(job?.params).toMatchObject({
                mode: "long",
                tone: "actionable",
                format: "qa",
                length: "detailed",
            });

            const again = await fetch(apiUrl(handle.port, `/videos/abc123def45/summary`), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer ytu_summary_enqueue",
                },
                body: SafeJSON.stringify(summaryBody),
            });
            const againBody = (await again.json()) as { jobId: number; reused: boolean };
            expect(again.status).toBe(200);
            expect(againBody.jobId).toBe(body.jobId);
            expect(againBody.reused).toBe(true);
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

            const statsResponse = await fetch(apiUrl(handle.port, `/cache/stats`));
            const statsBody = await statsResponse.json();

            expect(statsResponse.status).toBe(200);
            expect(statsBody.channels).toBe(1);
            expect(statsBody.videos).toBe(1);
            expect(statsBody.transcripts).toBe(1);

            const configResponse = await fetch(apiUrl(handle.port, `/config`));
            const configBody = await configResponse.json();

            expect(configResponse.status).toBe(200);
            expect(configBody.config.apiPort).toBe(9876);
            expect(configBody.where).toContain("server.json");

            const patchResponse = await fetch(apiUrl(handle.port, `/config`), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ apiPort: 9999 }),
            });
            const patchBody = await patchResponse.json();

            expect(patchResponse.status).toBe(200);
            expect(patchBody.config.apiPort).toBe(9999);

            const pruneResponse = await fetch(apiUrl(handle.port, `/cache/prune`), {
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

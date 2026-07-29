import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handlePipelineRoute } from "@app/youtube/lib/server/routes/pipeline";
import { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";

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

/** `route` is a `"<METHOD> <path>"` pair, mirroring how the routes are declared. */
async function call(route: string, token: string | null, body?: unknown): Promise<Response> {
    const [method, path] = route.split(" ");
    const url = new URL(`http://localhost${path}`);
    const headers: Record<string, string> = {};

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = SafeJSON.stringify(body, { strict: true });
    }

    return handlePipelineRoute(new Request(url, init), url, yt);
}

async function status(route: string, token: string | null, body?: unknown): Promise<number> {
    return (await call(route, token, body)).status;
}

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
        const body = (await res.json()) as {
            queue: {
                queued: number;
                running: number;
                perStage: Record<string, { queued: number; running: number }>;
                oldestQueuedAgeSec: number | null;
            };
        };

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
        const body = (await res.json()) as {
            queue: { queued: number; running: number; oldestQueuedAgeSec: number | null };
        };

        expect(res.status).toBe(200);
        expect(body.queue.queued).toBe(0);
        expect(body.queue.running).toBe(0);
        expect(body.queue.oldestQueuedAgeSec).toBeNull();
    });
});

describe("pipeline route job ownership", () => {
    // `requireServiceKey` lets ANY valid ytu_ token past the top-level gate, so
    // without per-user scoping one logged-in user reaches every other user's jobs.
    it("hides another user's job from list, get, activity and cancel", async () => {
        const alice = db.createUser({ email: "alice@example.com", passwordHash: "h", apiToken: "ytu_alice" });
        db.createUser({ email: "bob@example.com", passwordHash: "h", apiToken: "ytu_bob" });
        const { job } = db.enqueueJob({
            targetKind: "video",
            target: "vid00000001",
            stages: ["captions"],
            userId: alice.id,
        });

        expect(await status(`GET /api/v1/jobs/${job.id}`, "ytu_bob")).toBe(404);
        expect(await status(`GET /api/v1/jobs/${job.id}/activity`, "ytu_bob")).toBe(404);
        expect(await status(`POST /api/v1/jobs/${job.id}/cancel`, "ytu_bob")).toBe(404);

        const listed = await call("GET /api/v1/jobs", "ytu_bob");

        expect(listed.status).toBe(200);
        expect(((await listed.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);
    });

    it("lets the owner reach their own job, and the operator reach every job", async () => {
        const alice = db.createUser({ email: "alice@example.com", passwordHash: "h", apiToken: "ytu_alice" });
        const { job } = db.enqueueJob({
            targetKind: "video",
            target: "vid00000001",
            stages: ["captions"],
            userId: alice.id,
        });

        expect(await status(`GET /api/v1/jobs/${job.id}`, "ytu_alice")).toBe(200);
        expect(await status(`GET /api/v1/jobs/${job.id}/activity`, "ytu_alice")).toBe(200);

        // No user token: the service-key/localhost operator, which is how the CLI
        // and the dashboard see the whole queue.
        expect(await status(`GET /api/v1/jobs/${job.id}`, null)).toBe(200);

        const listed = await call("GET /api/v1/jobs", null);

        expect(((await listed.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
    });

    it("keeps an unowned CLI job out of every user's view", async () => {
        db.createUser({ email: "alice@example.com", passwordHash: "h", apiToken: "ytu_alice" });
        const { job } = db.enqueueJob({ targetKind: "video", target: "vid00000002", stages: ["captions"] });

        expect(await status(`GET /api/v1/jobs/${job.id}`, "ytu_alice")).toBe(404);
        expect(await status(`GET /api/v1/jobs/${job.id}`, null)).toBe(200);
    });
});

describe("POST /api/v1/pipeline validation", () => {
    // Each of these used to reach the outer catch and come back a 500: a client
    // mistake reported as a server fault.
    it("rejects malformed JSON with 400", async () => {
        const url = new URL("http://localhost/api/v1/pipeline");
        const req = new Request(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not json",
        });
        const res = await handlePipelineRoute(req, url, yt);

        expect(res.status).toBe(400);
    });

    it("rejects a body that is not a JSON object", async () => {
        expect(await status("POST /api/v1/pipeline", null, null)).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, ["captions"])).toBe(400);
    });

    it("rejects a missing, empty or mistyped target", async () => {
        expect(await status("POST /api/v1/pipeline", null, { stages: ["captions"] })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: "   ", stages: ["captions"] })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: 7, stages: ["captions"] })).toBe(400);
    });

    it("rejects missing, non-array, empty and invalid stages", async () => {
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001" })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001", stages: "captions" })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001", stages: [] })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001", stages: ["bogus"] })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001", stages: [3] })).toBe(400);
    });

    it("rejects an unknown targetKind, a non-numeric priority and non-object params", async () => {
        const base = { target: "vid00000001", stages: ["captions"] };

        expect(await status("POST /api/v1/pipeline", null, { ...base, targetKind: "planet" })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { ...base, priority: "high" })).toBe(400);
        expect(await status("POST /api/v1/pipeline", null, { ...base, params: "nope" })).toBe(400);
    });

    it("accepts a well-formed body", async () => {
        expect(await status("POST /api/v1/pipeline", null, { target: "vid00000001", stages: ["captions"] })).toBe(200);
    });
});

describe("POST /api/v1/jobs/:id/cancel", () => {
    it("returns 404 for a job id that does not exist", async () => {
        expect(await status("POST /api/v1/jobs/424242/cancel", null)).toBe(404);
    });
});

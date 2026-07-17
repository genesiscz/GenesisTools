import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleCollectionsRoute } from "@app/youtube/lib/server/routes/collections";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-collections-routes-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "One" });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function call(method: string, path: string, token?: string, bodyObj?: unknown) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
        },
        ...(bodyObj !== undefined ? { body: SafeJSON.stringify(bodyObj, { strict: true }) } : {}),
    });
    const res = await handleCollectionsRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("collections routes", () => {
    it("requires login with the typed code", async () => {
        const res = await call("GET", "/api/v1/collections");

        expect(res.status).toBe(401);
        expect(res.json.code).toBe("login_required");
    });

    it("CRUD round-trip with ownership isolation", async () => {
        const owner = createUser("o@example.com");
        const stranger = createUser("s@example.com");
        const created = await call("POST", "/api/v1/collections", owner.token, { name: "Picks", kind: "manual" });

        expect(created.status).toBe(200);
        const id = (created.json.collection as { id: number }).id;

        await call("POST", `/api/v1/collections/${id}/videos`, owner.token, { videoId: "vid00000001" });
        const detail = await call("GET", `/api/v1/collections/${id}`, owner.token);
        const videos = detail.json.videos as Array<{ id: string }>;

        expect(videos.map((video) => video.id)).toEqual(["vid00000001"]);
        expect((await call("GET", `/api/v1/collections/${id}`, stranger.token)).status).toBe(404);
        expect((await call("PATCH", `/api/v1/collections/${id}`, owner.token, { name: "Picks 2" })).status).toBe(200);
        expect((await call("DELETE", `/api/v1/collections/${id}/videos/vid00000001`, owner.token)).status).toBe(200);
        expect((await call("DELETE", `/api/v1/collections/${id}`, owner.token)).json.deleted).toBe(true);
    });

    it("validates dynamic rules at creation", async () => {
        const owner = createUser("d@example.com");
        const bad = await call("POST", "/api/v1/collections", owner.token, {
            name: "broken",
            kind: "dynamic",
            rule: { type: "nope" },
        });

        expect(bad.status).toBe(400);

        const good = await call("POST", "/api/v1/collections", owner.token, {
            name: "last month",
            kind: "dynamic",
            rule: { type: "watched", sinceDays: 30 },
        });

        expect(good.status).toBe(200);
        db.recordVideoWatch({ userId: owner.id, videoId: "vid00000001" });
        const detail = await call(
            "GET",
            `/api/v1/collections/${(good.json.collection as { id: number }).id}`,
            owner.token
        );

        expect((detail.json.videos as unknown[]).length).toBe(1);
    });
});

describe("POST /collections/:id/ask (pre-LLM paths)", () => {
    it("404s foreign collections and 400s a missing question", async () => {
        const owner = createUser("a1@example.com");
        const stranger = createUser("a2@example.com");
        const created = await call("POST", "/api/v1/collections", owner.token, { name: "c", kind: "manual" });
        const id = (created.json.collection as { id: number }).id;

        expect((await call("POST", `/api/v1/collections/${id}/ask`, stranger.token, { question: "?" })).status).toBe(
            404
        );
        expect((await call("POST", `/api/v1/collections/${id}/ask`, owner.token, {})).status).toBe(400);
    });

    it("402s with a typed code when the balance cannot cover the ask", async () => {
        const owner = createUser("a3@example.com");
        const created = await call("POST", "/api/v1/collections", owner.token, { name: "c", kind: "manual" });
        const id = (created.json.collection as { id: number }).id;
        const res = await call("POST", `/api/v1/collections/${id}/ask`, owner.token, { question: "hi" });

        expect(res.status).toBe(402);
        expect(res.json.code).toBe("insufficient_credits");
    });
});

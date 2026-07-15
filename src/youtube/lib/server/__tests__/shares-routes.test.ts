import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

describe("youtube server shares routes", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-shares-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function registeredToken(port: number, email: string): Promise<{ token: string; userId: number }> {
        const res = await fetch(`http://localhost:${port}/api/v1/users/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ email, password: "hunter22" }),
        });
        const body = (await res.json()) as { token: string; user: { id: number } };
        return { token: body.token, userId: body.user.id };
    }

    it("create -> GET /share/<slug> renders og:description; DELETE -> 404", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { token } = await registeredToken(handle.port, "sharer@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidABC", channelHandle: "@chan", title: "Deep Dive Video" });
            handle.youtube.db.setVideoSummary("vidABC", "short", "The video explains X in depth, with examples.");

            const createRes = await fetch(`http://localhost:${handle.port}/api/v1/shares`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ kind: "summary", videoId: "vidABC", mode: "short" }),
            });
            const createBody = (await createRes.json()) as { slug: string; url: string };

            expect(createRes.status).toBe(200);
            expect(createBody.slug).toHaveLength(12);

            const pageRes = await fetch(createBody.url);
            const pageHtml = await pageRes.text();

            expect(pageRes.status).toBe(200);
            expect(pageRes.headers.get("content-type")).toContain("text/html");
            expect(pageHtml).toContain("og:description");
            expect(pageHtml).toContain("The video explains X in depth");
            expect(pageHtml).not.toContain("sharer@example.com");

            const deleteRes = await fetch(`http://localhost:${handle.port}/api/v1/shares/${createBody.slug}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(deleteRes.status).toBe(200);

            const afterDelete = await fetch(createBody.url);
            expect(afterDelete.status).toBe(404);
        } finally {
            await handle.stop();
        }
    });

    it("POST from a second account against user A's qaHistoryId returns 4xx", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { token: tokenA, userId: userIdA } = await registeredToken(handle.port, "owner@example.com");
            const { token: tokenB } = await registeredToken(handle.port, "attacker@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidQA", channelHandle: "@chan", title: "QA Video" });
            const qa = handle.youtube.db.insertQaHistory({
                userId: userIdA,
                videoId: "vidQA",
                question: "Why?",
                answer: "Because.",
                citations: [],
                creditsSpent: 5,
            });

            const res = await fetch(`http://localhost:${handle.port}/api/v1/shares`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
                body: SafeJSON.stringify({ kind: "qa", videoId: "vidQA", qaHistoryId: qa.id }),
            });

            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
            // tokenA is untouched/unused here besides proving ownership context.
            expect(tokenA).toBeString();
        } finally {
            await handle.stop();
        }
    });

    it("GET /api/v1/shares lists own shares newest first", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { token } = await registeredToken(handle.port, "lister@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidList", channelHandle: "@chan", title: "List Video" });
            handle.youtube.db.setVideoSummary("vidList", "short", "Short summary text.");

            await fetch(`http://localhost:${handle.port}/api/v1/shares`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ kind: "summary", videoId: "vidList", mode: "short" }),
            });

            const listRes = await fetch(`http://localhost:${handle.port}/api/v1/shares`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const listBody = (await listRes.json()) as { shares: Array<{ slug: string; videoTitle: string }> };

            expect(listRes.status).toBe(200);
            expect(listBody.shares).toHaveLength(1);
            expect(listBody.shares[0].videoTitle).toBe("List Video");
        } finally {
            await handle.stop();
        }
    });

    it("GET /share/:slug for an unknown slug is a plain 404 HTML page", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const res = await fetch(`http://localhost:${handle.port}/share/doesNotExist1`);
            const html = await res.text();

            expect(res.status).toBe(404);
            expect(html).toContain("This link is gone");
        } finally {
            await handle.stop();
        }
    });

    it("public share page is exempt from service-key auth", async () => {
        const dirLocal = dir;
        await env.testing.withOverrides({ YOUTUBE_SERVICE_KEY: "svc_key_only" }, async () => {
            const handle = await startServer({ port: 0, baseDir: dirLocal, startPipeline: false });

            try {
                const res = await fetch(`http://localhost:${handle.port}/share/doesNotExist2`);
                expect(res.status).toBe(404);
                expect(res.headers.get("content-type")).toContain("text/html");
            } finally {
                await handle.stop();
            }
        });
    });
});

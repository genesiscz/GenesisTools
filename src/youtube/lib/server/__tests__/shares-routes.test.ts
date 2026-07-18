import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@app/youtube/lib/server";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { apiUrl } from "./test-helpers";

describe("youtube server shares routes", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-shares-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function registeredToken(port: number, email: string): Promise<{ token: string; userId: number }> {
        const res = await fetch(apiUrl(port, `/users/register`), {
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
            const { token, userId } = await registeredToken(handle.port, "sharer@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidABC", channelHandle: "@chan", title: "Deep Dive Video" });
            handle.youtube.db.setVideoSummary("vidABC", "short", "The video explains X in depth, with examples.");
            handle.youtube.db.insertArtifactAccess({
                userId,
                kind: "summary:short",
                videoId: "vidABC",
                creditsSpent: 0,
            });

            const createRes = await fetch(apiUrl(handle.port, `/shares`), {
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

            const deleteRes = await fetch(apiUrl(handle.port, `/shares/${createBody.slug}`), {
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

    it("POST summary share without artifact access returns 403", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { token } = await registeredToken(handle.port, "nofunds@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidLocked", channelHandle: "@chan", title: "Locked Video" });
            handle.youtube.db.setVideoSummary("vidLocked", "short", "Someone else generated this summary.");

            const res = await fetch(apiUrl(handle.port, `/shares`), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ kind: "summary", videoId: "vidLocked", mode: "short" }),
            });

            expect(res.status).toBe(403);
            expect(((await res.json()) as { error: string }).error).toBe("artifact access required");
        } finally {
            await handle.stop();
        }
    });

    it("POST from a second account against user A's qaHistoryId returns 404 not-found", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { userId: userIdA } = await registeredToken(handle.port, "owner@example.com");
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

            const res = await fetch(apiUrl(handle.port, `/shares`), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
                body: SafeJSON.stringify({ kind: "qa", videoId: "vidQA", qaHistoryId: qa.id }),
            });

            // B cannot resolve A's qaHistory row, so createShare treats it as absent.
            expect(res.status).toBe(404);
            const body = (await res.json()) as { error: string };
            expect(body.error).toBe("qa history entry not found");
        } finally {
            await handle.stop();
        }
    });

    it("GET /api/v1/shares lists own shares newest first", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const { token, userId } = await registeredToken(handle.port, "lister@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidList", channelHandle: "@chan", title: "List Video" });
            handle.youtube.db.setVideoSummary("vidList", "short", "Short summary text.");
            handle.youtube.db.insertArtifactAccess({
                userId,
                kind: "summary:short",
                videoId: "vidList",
                creditsSpent: 0,
            });

            // Two distinguishable shares so "newest first" is actually exercised.
            handle.youtube.db.upsertVideo({ id: "vidList2", channelHandle: "@chan", title: "Second Video" });
            handle.youtube.db.setVideoSummary("vidList2", "short", "Second summary text.");
            handle.youtube.db.insertArtifactAccess({
                userId,
                kind: "summary:short",
                videoId: "vidList2",
                creditsSpent: 0,
            });

            await fetch(apiUrl(handle.port, `/shares`), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ kind: "summary", videoId: "vidList", mode: "short" }),
            });
            await fetch(apiUrl(handle.port, `/shares`), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ kind: "summary", videoId: "vidList2", mode: "short" }),
            });

            const listRes = await fetch(apiUrl(handle.port, `/shares`), {
                headers: { Authorization: `Bearer ${token}` },
            });
            const listBody = (await listRes.json()) as { shares: Array<{ slug: string; videoTitle: string }> };

            expect(listRes.status).toBe(200);
            expect(listBody.shares).toHaveLength(2);
            expect(listBody.shares[0].videoTitle).toBe("Second Video");
            expect(listBody.shares[1].videoTitle).toBe("List Video");
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

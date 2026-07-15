import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import {
    createShare,
    listShares,
    renderShareNotFoundPage,
    renderSharePage,
    revokeShare,
    SHARE_SLUG_LENGTH,
} from "@app/youtube/lib/shares";

const BASE_URL = "http://localhost:9876";

describe("shares", () => {
    let db: YoutubeDatabase;

    beforeEach(() => {
        db = new YoutubeDatabase(":memory:");
    });

    afterEach(() => {
        db.close();
    });

    function createTestUser(email = "user@example.com") {
        return db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
    }

    function seedVideo(id = "vid123") {
        db.upsertChannel({ handle: "@channel" });
        db.upsertVideo({ id, channelHandle: "@channel", title: "Test Video" });
        db.setVideoSummary(id, "short", "This is the short summary of the video, quite informative.");
        return id;
    }

    it("slug is 12 base62 characters", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        const { slug } = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });

        expect(slug).toHaveLength(SHARE_SLUG_LENGTH);
        expect(slug).toMatch(/^[A-Za-z0-9]{12}$/);
    });

    it("snapshot immutability: regenerating the summary after share leaves the page unchanged", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        const { slug } = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        const before = renderSharePage(db.getShareBySlug(slug)!);

        db.setVideoSummary(videoId, "short", "A completely different, mutated summary.");

        const after = renderSharePage(db.getShareBySlug(slug)!);
        expect(after).toBe(before);
        expect(after).toContain("This is the short summary");
    });

    it("revoked share is treated as missing by the route layer (revokedAt set)", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        const { slug } = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        const revoked = revokeShare(db, user.id, slug);
        const row = db.getShareBySlug(slug);

        expect(revoked).toBe(true);
        expect(row?.revoked_at).not.toBeNull();
    });

    it("revoking twice is a no-op the second time", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        const { slug } = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        expect(revokeShare(db, user.id, slug)).toBe(true);
        expect(revokeShare(db, user.id, slug)).toBe(false);
    });

    it("the 11th share within an hour throws; the first 10 succeed", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        for (let i = 0; i < 10; i++) {
            await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        }

        await expect(
            createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL })
        ).rejects.toThrow("share rate limit reached");
    });

    it("qa share of another user's qa_history row throws", async () => {
        const owner = createTestUser("owner@example.com");
        const attacker = createTestUser("attacker@example.com");
        const videoId = seedVideo();
        const qa = db.insertQaHistory({
            userId: owner.id,
            videoId,
            question: "What's the thesis?",
            answer: "It's about X.",
            citations: [],
            creditsSpent: 5,
        });

        await expect(
            createShare({ db, user: attacker, kind: "qa", videoId, qaHistoryId: qa.id, baseUrl: BASE_URL })
        ).rejects.toThrow("qa history entry not found");
    });

    it("renders a valid qa share with citations linked to watch URLs", async () => {
        const user = createTestUser();
        const videoId = seedVideo();
        const qa = db.insertQaHistory({
            userId: user.id,
            videoId,
            question: "What's the thesis?",
            answer: "It's about X.",
            citations: [{ videoId, chunkIdx: 0, startSec: 42, endSec: 60 }],
            creditsSpent: 5,
        });

        const { slug } = await createShare({ db, user, kind: "qa", videoId, qaHistoryId: qa.id, baseUrl: BASE_URL });
        const html = renderSharePage(db.getShareBySlug(slug)!);

        expect(html).toContain("What's the thesis?");
        // `&` is HTML-escaped inside the href attribute — that's correct output.
        expect(html).toContain(`https://www.youtube.com/watch?v=${videoId}&amp;t=42s`);
        expect(html).toContain("og:description");
        expect(html).not.toContain(user.email);
    });

    it("renderShareNotFoundPage never leaks anything about the share", () => {
        const html = renderShareNotFoundPage();
        expect(html).toContain("This link is gone");
    });

    it("listShares returns newest first and includes revoked state", async () => {
        const user = createTestUser();
        const videoId = seedVideo();
        const first = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        const second = await createShare({ db, user, kind: "summary", videoId, mode: "short", baseUrl: BASE_URL });
        revokeShare(db, user.id, first.slug);

        const list = listShares(db, user.id, BASE_URL);

        expect(list.map((s) => s.slug)).toEqual([second.slug, first.slug]);
        expect(list.find((s) => s.slug === first.slug)?.revokedAt).not.toBeNull();
        expect(list.find((s) => s.slug === second.slug)?.revokedAt).toBeNull();
    });

    it("throws when sharing a summary mode that hasn't been generated yet", async () => {
        const user = createTestUser();
        const videoId = seedVideo();

        await expect(
            createShare({ db, user, kind: "summary", videoId, mode: "long", baseUrl: BASE_URL })
        ).rejects.toThrow("no long summary generated");
    });
});

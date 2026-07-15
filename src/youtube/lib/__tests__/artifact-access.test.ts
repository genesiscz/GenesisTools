import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { grantArtifactAccess, resolveArtifactPrice } from "@app/youtube/lib/artifact-access";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { CREDIT_COSTS, REUSE_COST } from "@app/youtube/lib/users.types";
import type { VideoId } from "@app/youtube/lib/video.types";

const HANDLE = "@chan" as ChannelHandle;
const VIDEO = "vid00000001" as VideoId;

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: HANDLE });
    db.upsertVideo({ id: VIDEO, channelHandle: HANDLE, title: "t" });
});

afterEach(() => {
    db.close();
});

function createUser(email: string) {
    return db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });
}

describe("artifact-access pricing matrix", () => {
    it("missing artifact → full generation price for everyone", () => {
        const a = createUser("a@example.com");

        expect(resolveArtifactPrice(db, { userId: a.id, kind: "summary:long", videoId: VIDEO })).toEqual({
            price: CREDIT_COSTS["summary:long"],
            reused: false,
        });
    });

    it("exists but locked → flat REUSE_COST; after unlock → 0; generator always 0", () => {
        const a = createUser("a@example.com");
        const b = createUser("b@example.com");

        // A generates: artifact stored + access row at full price.
        db.setVideoSummary(VIDEO, "long", {
            tldr: "the gist of it",
            keyPoints: [],
            learnings: [],
            chapters: [],
            conclusion: null,
        });
        grantArtifactAccess(db, {
            userId: a.id,
            kind: "summary:long",
            videoId: VIDEO,
            creditsSpent: CREDIT_COSTS["summary:long"],
        });

        expect(resolveArtifactPrice(db, { userId: a.id, kind: "summary:long", videoId: VIDEO })).toEqual({
            price: 0,
            reused: false,
        });
        expect(resolveArtifactPrice(db, { userId: b.id, kind: "summary:long", videoId: VIDEO })).toEqual({
            price: REUSE_COST,
            reused: true,
        });

        grantArtifactAccess(db, { userId: b.id, kind: "summary:long", videoId: VIDEO, creditsSpent: REUSE_COST });

        expect(resolveArtifactPrice(db, { userId: b.id, kind: "summary:long", videoId: VIDEO })).toEqual({
            price: 0,
            reused: false,
        });
        // A's access is untouched by B's unlock.
        expect(resolveArtifactPrice(db, { userId: a.id, kind: "summary:long", videoId: VIDEO })).toEqual({
            price: 0,
            reused: false,
        });
    });

    it("kinds are independent: unlocking long does not unlock short", () => {
        const b = createUser("b@example.com");
        db.setVideoSummary(VIDEO, "long", { tldr: "x", keyPoints: [], learnings: [], chapters: [], conclusion: null });
        db.setVideoSummary(VIDEO, "short", "short text");
        grantArtifactAccess(db, { userId: b.id, kind: "summary:long", videoId: VIDEO, creditsSpent: REUSE_COST });

        expect(resolveArtifactPrice(db, { userId: b.id, kind: "summary:short", videoId: VIDEO })).toEqual({
            price: REUSE_COST,
            reused: true,
        });
    });

    it("unlock is idempotent — double grant keeps one row with the original spend", () => {
        const b = createUser("b@example.com");
        grantArtifactAccess(db, { userId: b.id, kind: "summary:long", videoId: VIDEO, creditsSpent: REUSE_COST });
        grantArtifactAccess(db, { userId: b.id, kind: "summary:long", videoId: VIDEO, creditsSpent: 99 });

        const rows = db
            .getDb()
            .query("SELECT credits_spent FROM artifact_access WHERE user_id = ? AND kind = 'summary:long'")
            .all(b.id) as Array<{ credits_spent: number }>;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.credits_spent).toBe(REUSE_COST);
    });

    it("transcript:ai existence follows the transcripts table (source = 'ai')", () => {
        const b = createUser("b@example.com");

        expect(db.hasArtifact("transcript:ai", VIDEO)).toBe(false);

        db.saveTranscript({ videoId: VIDEO, lang: "en", source: "ai", text: "hello", segments: [] });

        expect(db.hasArtifact("transcript:ai", VIDEO)).toBe(true);
        expect(resolveArtifactPrice(db, { userId: b.id, kind: "transcript:ai", videoId: VIDEO })).toEqual({
            price: REUSE_COST,
            reused: true,
        });
    });
});

describe("artifact-access backfill", () => {
    it("grants existing users access to artifacts present when the migration first runs", () => {
        const a = createUser("a@example.com");
        const b = createUser("b@example.com");
        db.setVideoSummary(VIDEO, "short", "pre-existing summary");

        // Simulate a pre-migration database: drop the table, then re-run the
        // schema — the guarded migration recreates it and backfills once.
        db.getDb().exec("DROP TABLE artifact_access");
        db.initSchemaForTest();

        expect(db.hasArtifactAccess(a.id, "summary:short", VIDEO)).toBe(true);
        expect(db.hasArtifactAccess(b.id, "summary:short", VIDEO)).toBe(true);
        // No artifact → no backfill row for other kinds.
        expect(db.hasArtifactAccess(a.id, "summary:long", VIDEO)).toBe(false);

        // Users created AFTER the migration do not inherit backfill grants.
        const c = createUser("c@example.com");
        db.initSchemaForTest();

        expect(db.hasArtifactAccess(c.id, "summary:short", VIDEO)).toBe(false);
    });
});

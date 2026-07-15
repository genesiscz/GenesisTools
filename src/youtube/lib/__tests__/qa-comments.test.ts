import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { VideoComment } from "@app/youtube/lib/comments.types";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { chunkComments } from "@app/youtube/lib/qa";
import type { VideoId } from "@app/youtube/lib/video.types";

const VIDEO = "abc123def45" as VideoId;

function makeComment(overrides: Partial<VideoComment> & { commentId: string }): VideoComment {
    return {
        id: 0,
        videoId: VIDEO,
        author: "@viewer",
        authorId: null,
        text: "text",
        likeCount: null,
        publishedAt: null,
        parentCommentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("chunkComments", () => {
    it("keeps replies with their root thread, in fetch order, with @handles preserved", () => {
        const chunks = chunkComments([
            makeComment({ commentId: "r1", author: "@alice", text: "root one" }),
            makeComment({ commentId: "r1a", author: "@bob", text: "first reply", parentCommentId: "r1" }),
            makeComment({ commentId: "r1b", author: "@carol", text: "second reply", parentCommentId: "r1" }),
        ]);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.rootCommentId).toBe("r1");
        expect(chunks[0]?.text).toBe("@alice: root one\n@bob: first reply\n@carol: second reply");
    });

    it("treats replies to unknown parents as roots", () => {
        const chunks = chunkComments([makeComment({ commentId: "orphan", parentCommentId: "gone", text: "hello" })]);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.rootCommentId).toBe("orphan");
    });

    it("splits an oversize thread at reply boundaries, never mid-message", () => {
        const bigReply = (id: string) => makeComment({ commentId: id, parentCommentId: "root", text: "x".repeat(1900) });
        const comments = [
            makeComment({ commentId: "root", author: "@op", text: "y".repeat(1900) }),
            bigReply("a"),
            bigReply("b"),
            bigReply("c"),
        ];
        const chunks = chunkComments(comments);

        expect(chunks.length).toBeGreaterThan(1);

        for (const chunk of chunks) {
            expect(chunk.rootCommentId).toBe("root");

            // Every line is a complete original message — no mid-message cuts.
            for (const line of chunk.text.split("\n")) {
                expect(line).toMatch(/^@(op|viewer): [xy]+$/);
                expect(line.length).toBeGreaterThanOrEqual(1900);
            }
        }
    });

    it("merges tiny threads up to the target and keeps the FIRST thread's root id", () => {
        const chunks = chunkComments([
            makeComment({ commentId: "t1", author: "@a", text: "tiny one" }),
            makeComment({ commentId: "t2", author: "@b", text: "tiny two" }),
            makeComment({ commentId: "t3", author: "@c", text: "tiny three" }),
        ]);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.rootCommentId).toBe("t1");
        expect(chunks[0]?.text).toContain("@a: tiny one");
        expect(chunks[0]?.text).toContain("@c: tiny three");
    });
});

describe("qa_chunks source columns", () => {
    let db: YoutubeDatabase;

    beforeEach(() => {
        db = new YoutubeDatabase(":memory:");
        db.upsertChannel({ handle: "@chan" });
        db.upsertVideo({ id: VIDEO, channelHandle: "@chan", title: "t" });
    });

    afterEach(() => {
        db.close();
    });

    it("defaults to transcript source and round-trips comments chunks with sourceRef", () => {
        db.upsertQaChunk({ videoId: VIDEO, chunkIdx: 0, text: "plain", embedderModel: "default" });
        db.upsertQaChunk({
            videoId: VIDEO,
            chunkIdx: 100_000,
            text: "@a: hi",
            embedderModel: "default",
            source: "comments",
            sourceRef: "rootA",
        });

        const chunks = db.listQaChunks(VIDEO, "default");

        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toMatchObject({ source: "transcript", sourceRef: null });
        expect(chunks[1]).toMatchObject({ source: "comments", sourceRef: "rootA" });
    });

    it("hasQaChunks filters by source", () => {
        db.upsertQaChunk({ videoId: VIDEO, chunkIdx: 0, text: "plain", embedderModel: "default" });

        expect(db.hasQaChunks(VIDEO, "default", "transcript")).toBe(true);
        expect(db.hasQaChunks(VIDEO, "default", "comments")).toBe(false);
    });

    it("qa_history stores and returns the ask sources", () => {
        const user = db.createUser({ email: "a@example.com", passwordHash: "h", apiToken: "ytu_a" });
        const item = db.insertQaHistory({
            userId: user.id,
            videoId: VIDEO,
            question: "q",
            answer: "a",
            citations: [],
            creditsSpent: 5,
            sources: ["transcript", "comments"],
        });

        expect(item.sources).toEqual(["transcript", "comments"]);
        expect(db.listQaHistory(user.id, VIDEO)[0]?.sources).toEqual(["transcript", "comments"]);

        const legacy = db.insertQaHistory({
            userId: user.id,
            videoId: VIDEO,
            question: "q2",
            answer: "a2",
            citations: [],
            creditsSpent: 5,
        });

        expect(legacy.sources).toBeUndefined();
    });
});

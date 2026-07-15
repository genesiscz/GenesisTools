import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoComment } from "@app/youtube/lib/comments.types";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { chunkComments, QaService } from "@app/youtube/lib/qa";
import type { QaServiceDeps } from "@app/youtube/lib/qa.types";
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
        const bigReply = (id: string) =>
            makeComment({ commentId: id, parentCommentId: "root", text: "x".repeat(1900) });
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

describe("QaService ask with comment sources", () => {
    it("Both scope indexes lazily, merges both sources, and tags citations", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-qa-comments-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });

        try {
            db.upsertChannel({ handle: "@chan" });
            db.upsertVideo({ id: VIDEO, channelHandle: "@chan", title: "t" });
            db.saveTranscript({
                videoId: VIDEO,
                lang: "en",
                source: "captions",
                text: "spoken words",
                segments: [{ text: "spoken words", start: 5, end: 9 }],
                durationSec: 9,
            });
            db.upsertComments(VIDEO, [
                {
                    commentId: "rootA",
                    author: "@alice",
                    authorId: null,
                    text: "viewers love this",
                    likeCount: 3,
                    publishedAt: null,
                    parentCommentId: null,
                },
            ]);

            const vectors = new Map<string, Float32Array>();
            const deps: QaServiceDeps = {
                createEmbedder: async () => ({
                    embed: async () => ({ vector: new Float32Array([1, 0]), dimensions: 2 }),
                    embedBatch: async (texts: string[]) =>
                        texts.map((text) => {
                            const vector = text.startsWith("@alice")
                                ? new Float32Array([0.9, 0.1])
                                : new Float32Array([1, 0]);
                            vectors.set(text, vector);

                            return { vector, dimensions: 2 };
                        }),
                    dispose: () => {},
                }),
                callLLM: async (opts) => {
                    expect(opts.systemPrompt).toContain(
                        "Claims sourced from comments must be attributed ('commenters point out…', 'one viewer disagrees…') — never present viewer opinions as statements made in the video."
                    );
                    expect(opts.userPrompt).toContain(`transcript t=5s] spoken words`);
                    expect(opts.userPrompt).toContain(`comment @alice] @alice: viewers love this`);

                    return { content: "Commenters point out [#2]." };
                },
            };
            const service = new QaService(db, config, deps);

            await service.index({ videoId: VIDEO, sources: ["transcript", "comments"] });

            expect(db.hasQaChunks(VIDEO, "default", "transcript")).toBe(true);
            expect(db.hasQaChunks(VIDEO, "default", "comments")).toBe(true);

            const result = await service.ask({
                videoIds: [VIDEO],
                question: "What do viewers think?",
                providerChoice: { provider: { name: "test" }, model: { id: "model" } } as never,
                sources: ["transcript", "comments"],
            });

            expect(result.citations).toHaveLength(2);
            expect(result.citations[0]).toMatchObject({ source: "transcript", author: null, commentId: null });
            expect(result.citations[1]).toMatchObject({
                source: "comments",
                author: "alice",
                commentId: "rootA",
            });
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("transcript-only ask ignores comment chunks and keeps the base prompt", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-qa-comments-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });

        try {
            db.upsertChannel({ handle: "@chan" });
            db.upsertVideo({ id: VIDEO, channelHandle: "@chan", title: "t" });
            db.upsertQaChunk({ videoId: VIDEO, chunkIdx: 0, text: "spoken", embedding: new Float32Array([1, 0]), embedderModel: "default" });
            db.upsertQaChunk({
                videoId: VIDEO,
                chunkIdx: 100_000,
                text: "@a: comment",
                embedding: new Float32Array([1, 0]),
                embedderModel: "default",
                source: "comments",
                sourceRef: "rootA",
            });

            const deps: QaServiceDeps = {
                createEmbedder: async () => ({
                    embed: async () => ({ vector: new Float32Array([1, 0]), dimensions: 2 }),
                    embedBatch: async () => [],
                    dispose: () => {},
                }),
                callLLM: async (opts) => {
                    expect(opts.systemPrompt).not.toContain("Claims sourced from comments");
                    expect(opts.userPrompt).not.toContain("comment @a");

                    return { content: "answer" };
                },
            };
            const service = new QaService(db, config, deps);
            const result = await service.ask({
                videoIds: [VIDEO],
                question: "q",
                providerChoice: { provider: { name: "test" }, model: { id: "model" } } as never,
            });

            expect(result.citations).toHaveLength(1);
            expect(result.citations[0]?.source).toBe("transcript");
        } finally {
            db.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

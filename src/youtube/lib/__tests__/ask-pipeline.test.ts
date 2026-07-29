import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { answerOverVideos } from "@app/youtube/lib/ask-answer";
import { resolveAskScope } from "@app/youtube/lib/ask-scope";
import { askInSession, ensureAskSession, resolveSessionVideoIds } from "@app/youtube/lib/ask-session";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { AskOpts, IndexOpts } from "@app/youtube/lib/qa.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import { Youtube } from "@app/youtube/lib/youtube";
import type { ProviderChoice } from "@ask/types";

const providerChoice = {
    provider: { name: "fake" },
    model: { id: "fake-model" },
} as unknown as ProviderChoice;

let db: YoutubeDatabase;
let yt: Youtube;
let indexed: IndexOpts[];
let asked: AskOpts[];

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ db });
    indexed = [];
    asked = [];
    yt.qa.index = async (opts) => {
        indexed.push(opts);

        return { indexed: 1, modelId: opts.model ?? "default" };
    };
    yt.qa.ask = async (opts) => {
        asked.push(opts);

        return { answer: "an answer", citations: [] };
    };
    db.upsertChannel({ handle: "@chan" });
});

afterEach(() => {
    db.close();
});

function seedVideo(id: string, title: string): VideoId {
    db.upsertVideo({ id, channelHandle: "@chan", title });
    db.saveTranscript({
        videoId: id,
        lang: "en",
        source: "captions",
        text: "the answer is 42",
        segments: [{ text: "the answer is 42", start: 0, end: 2 }],
    });

    return id as VideoId;
}

function seedChunk(videoId: VideoId, opts: { model?: string; source?: "transcript" | "comments" } = {}): void {
    db.upsertQaChunk({
        videoId,
        chunkIdx: opts.source === "comments" ? 100_000 : 0,
        text: "the answer is 42",
        embedderModel: opts.model ?? "default",
        source: opts.source ?? "transcript",
    });
}

describe("answerOverVideos index gating", () => {
    it("skips indexing when the requested source already has chunks in the default model bucket", async () => {
        const videoId = seedVideo("vidIndexed01", "Indexed");
        seedChunk(videoId);

        await answerOverVideos({ yt, videoIds: [videoId], question: "what?", providerChoice });

        expect(indexed).toHaveLength(0);
        expect(asked[0]?.videoIds).toEqual([videoId]);
    });

    it("indexes when only another source has chunks", async () => {
        // The regression this pins: `hasQaChunks(videoId)` with no source/model was
        // true for a comments-only video, so it was searched with no transcript
        // context at all.
        const videoId = seedVideo("vidComments1", "Comments only");
        seedChunk(videoId, { source: "comments" });

        await answerOverVideos({ yt, videoIds: [videoId], question: "what?", providerChoice });

        expect(indexed.map((opts) => opts.videoId)).toEqual([videoId]);
    });

    it("indexes when the existing chunks belong to a different embedder model", async () => {
        const videoId = seedVideo("vidOtherMod1", "Other model");
        seedChunk(videoId, { model: "bge-small" });

        await answerOverVideos({ yt, videoIds: [videoId], question: "what?", providerChoice });

        expect(indexed.map((opts) => opts.videoId)).toEqual([videoId]);
    });

    it("indexes a transcript-indexed video when comments are also requested", async () => {
        const videoId = seedVideo("vidBothSrc1", "Both");
        seedChunk(videoId);

        await answerOverVideos({
            yt,
            videoIds: [videoId],
            question: "what?",
            providerChoice,
            sources: ["transcript", "comments"],
        });

        expect(indexed.map((opts) => opts.videoId)).toEqual([videoId]);
    });

    it("reports videos with no transcript instead of indexing them", async () => {
        const withTranscript = seedVideo("vidHasText1", "Has text");
        db.upsertVideo({ id: "vidNoText001", channelHandle: "@chan", title: "No text" });

        const result = await answerOverVideos({
            yt,
            videoIds: [withTranscript, "vidNoText001" as VideoId],
            question: "what?",
            providerChoice,
        });

        expect(result.missingTranscript).toEqual(["vidNoText001"]);
        expect(result.searchedVideoIds).toEqual([withTranscript]);
    });
});

describe("resolveAskScope", () => {
    it("rejects an empty selector", async () => {
        await expect(resolveAskScope(yt, {})).rejects.toThrow("pass a channel");
    });

    it("rejects two selectors at once", async () => {
        await expect(resolveAskScope(yt, { channel: "@chan", videoIds: ["vidAny00001"] })).rejects.toThrow(
            "mutually exclusive"
        );
    });

    it("dedupes an explicit id list", async () => {
        const scope = await resolveAskScope(yt, { videoIds: ["vidDupe0001", "vidDupe0001", "vidDupe0002"] });

        expect(scope).toMatchObject({ kind: "videos", value: "", videoIds: ["vidDupe0001", "vidDupe0002"] });
    });

    it("resolves a channel to its stored videos", async () => {
        const first = seedVideo("vidChan0001", "First");
        seedVideo("vidChan0002", "Second");
        const scope = await resolveAskScope(yt, { channel: "@chan" });

        expect(scope.kind).toBe("channel");
        expect(scope.videoIds).toContain(first);
        expect(scope.videoIds).toHaveLength(2);
    });
});

describe("ask sessions", () => {
    it("reuses an existing session of the same name for the same owner", async () => {
        const scope = { videoIds: ["vidSess0001"] };
        const first = await ensureAskSession({ yt, userId: 1, name: "digest", scope });
        const second = await ensureAskSession({ yt, userId: 1, name: "digest", scope });

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.session.id).toBe(first.session.id);
    });

    it("keeps sessions of the same name separate per owner", async () => {
        const scope = { videoIds: ["vidSess0001"] };
        const mine = await ensureAskSession({ yt, userId: 1, name: "digest", scope });
        const theirs = await ensureAskSession({ yt, userId: 2, name: "digest", scope });

        expect(theirs.created).toBe(true);
        expect(theirs.session.id).not.toBe(mine.session.id);
    });

    it("resolves a collection session through the collection's membership, not the empty cache", async () => {
        // Rows migrated from `ask_threads` are collection-backed and carry
        // `video_ids_json = '[]'`, so the stored list is never the authority here.
        const videoId = seedVideo("vidInColl01", "In collection");
        const collection = db.createCollection({ userId: 1, name: "watchlist", kind: "manual" });
        db.addCollectionVideo(collection.id, videoId);
        const session = db.createAskSession({
            userId: 1,
            title: "collection session",
            scopeKind: "collection",
            collectionId: collection.id,
        });

        expect(session.videoIds).toEqual([]);
        expect(await resolveSessionVideoIds(yt, session)).toEqual([videoId]);
    });

    it("returns no videos when a collection session's collection is gone", async () => {
        const session = db.createAskSession({
            userId: 1,
            title: "orphan",
            scopeKind: "collection",
            collectionId: 4242,
        });

        expect(await resolveSessionVideoIds(yt, session)).toEqual([]);
    });

    it("refreshes a channel session's members on every ask", async () => {
        seedVideo("vidChanSes1", "First");
        const session = db.createAskSession({
            userId: 1,
            title: "channel session",
            scopeKind: "channel",
            scopeValue: "@chan",
            videoIds: ["vidChanSes1"],
        });
        seedVideo("vidChanSes2", "Second uploaded later");

        expect(await resolveSessionVideoIds(yt, session)).toHaveLength(2);
        expect(db.getAskSession(1, session.id)?.videoIds).toHaveLength(2);
    });

    it("replays prior turns as history without repeating the current question", async () => {
        const videoId = seedVideo("vidHistory1", "History");
        seedChunk(videoId);
        const { session } = await ensureAskSession({
            yt,
            userId: 1,
            name: "history",
            scope: { videoIds: [videoId] },
        });

        await askInSession({ yt, session, question: "what changed?", providerChoice });
        const second = await askInSession({ yt, session, question: "expand on that", providerChoice });

        expect(asked[0]?.history ?? []).toEqual([]);
        expect(asked[1]?.history).toEqual([
            { role: "user", content: "what changed?" },
            { role: "assistant", content: "an answer" },
        ]);
        expect(second.turn).toBe(4);
    });
});

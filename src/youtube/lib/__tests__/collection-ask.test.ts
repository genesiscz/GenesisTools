import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { askCollection, MAX_TOOL_CALLS } from "@app/youtube/lib/collection-ask";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { ProviderChoice } from "@ask/types";

let db: YoutubeDatabase;
const providerChoice = {
    provider: { name: "fake" },
    model: { id: "fake-model" },
} as unknown as ProviderChoice;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({ id: "vidWatched01", channelHandle: "@chan", title: "Watched" });
    db.upsertVideo({ id: "vidUnseen001", channelHandle: "@chan", title: "Unseen" });
    db.saveTranscript({
        videoId: "vidWatched01",
        lang: "en",
        source: "captions",
        text: "the answer is 42",
        segments: [{ text: "the answer is 42", start: 0, end: 2 }],
    });
    db.recordVideoWatch({ userId: 1, videoId: "vidWatched01" });
});

afterEach(() => {
    db.close();
});

function setupCollection() {
    const collection = db.createCollection({ userId: 1, name: "test", kind: "manual" });
    db.addCollectionVideo(collection.id, "vidWatched01");
    db.addCollectionVideo(collection.id, "vidUnseen001");

    return collection;
}

type FakeStep =
    | { action: "list_videos" }
    | { action: "get_transcript"; videoId: string }
    | { action: "answer"; text: string };

function fakeLLM(steps: FakeStep[]) {
    const prompts: string[] = [];
    let index = 0;
    const deps = {
        callLLMStructured: async (opts: { userPrompt: string }) => {
            prompts.push(opts.userPrompt);
            const step = steps[Math.min(index, steps.length - 1)];
            index += 1;

            return {
                object: step,
                content: SafeJSON.stringify(step, { strict: true }),
            };
        },
    };

    return { deps, prompts };
}

describe("askCollection", () => {
    it("answers directly with zero tool calls and persists the thread", async () => {
        const collection = setupCollection();
        const { deps } = fakeLLM([{ action: "answer", text: "All about testing." }]);
        const result = await askCollection({ db, userId: 1, collection, question: "Theme?", providerChoice, deps });

        expect(result.answer).toBe("All about testing.");
        expect(result.toolCalls).toBe(0);
        const messages = db.listAskMessages(result.threadId);

        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    });

    it("runs tools, feeds results back, and gates unwatched transcripts", async () => {
        const collection = setupCollection();
        const { deps, prompts } = fakeLLM([
            { action: "list_videos" },
            { action: "get_transcript", videoId: "vidWatched01" },
            { action: "get_transcript", videoId: "vidUnseen001" },
            { action: "answer", text: "42, from the one video you watched." },
        ]);
        const result = await askCollection({ db, userId: 1, collection, question: "What?", providerChoice, deps });

        expect(result.toolCalls).toBe(3);
        const toolMessages = db.listAskMessages(result.threadId).filter((message) => message.role === "tool");

        expect(toolMessages).toHaveLength(3);
        expect(toolMessages[0].toolName).toBe("list_videos");
        expect(toolMessages[1].content).toContain("the answer is 42");
        expect(toolMessages[2].content).toContain("REFUSED");
        expect(prompts.at(-1)).toContain("REFUSED");
    });

    it("throws once the tool budget is exhausted without an answer", async () => {
        const collection = setupCollection();
        const { deps } = fakeLLM([{ action: "list_videos" }]);

        await expect(
            askCollection({ db, userId: 1, collection, question: "Loop?", providerChoice, deps })
        ).rejects.toThrow("tool budget");
        const collectionThread = db.listAskThreads(1, collection.id)[0];

        expect(db.listAskMessages(collectionThread.id).filter((message) => message.role === "tool")).toHaveLength(
            MAX_TOOL_CALLS
        );
    });

    it("continues an existing thread and rejects foreign threads", async () => {
        const collection = setupCollection();
        const { deps } = fakeLLM([{ action: "answer", text: "first" }]);
        const first = await askCollection({ db, userId: 1, collection, question: "One?", providerChoice, deps });
        const { deps: deps2 } = fakeLLM([{ action: "answer", text: "second" }]);
        const second = await askCollection({
            db,
            userId: 1,
            collection,
            question: "Two?",
            threadId: first.threadId,
            providerChoice,
            deps: deps2,
        });

        expect(second.threadId).toBe(first.threadId);
        expect(db.listAskMessages(first.threadId)).toHaveLength(4);

        await expect(
            askCollection({
                db,
                userId: 2,
                collection,
                question: "steal",
                threadId: first.threadId,
                providerChoice,
                deps,
            })
        ).rejects.toThrow("unknown ask thread");
    });
});

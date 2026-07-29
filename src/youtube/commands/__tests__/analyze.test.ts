import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AskResult, ChannelHandle, TimestampedSummaryEntry, Video, VideoId } from "@app/youtube/lib/types";
import { Command } from "commander";

const videos: Video[] = [
    {
        id: "abc123def45" as VideoId,
        channelHandle: "@mkbhd" as ChannelHandle,
        title: "iPhone review",
        description: "A detailed phone review",
        uploadDate: "2026-04-01",
        durationSec: 90,
        viewCount: null,
        likeCount: null,
        language: "en",
        availableCaptionLangs: ["en"],
        tags: [],
        isShort: false,
        isLive: false,
        thumbUrl: null,
        summaryShort: "Short summary",
        summaryTimestamped: null,
        summaryLong: null,
        summaryShortLang: "en",
        summaryTimestampedLang: "en",
        summaryLongLang: "en",
        audioPath: null,
        audioSizeBytes: null,
        audioCachedAt: null,
        videoPath: null,
        videoSizeBytes: null,
        videoCachedAt: null,
        thumbPath: null,
        thumbCachedAt: null,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
    },
];

const calls = {
    summarize: [] as unknown[],
    index: [] as unknown[],
    ask: [] as unknown[],
};

mock.module("@app/youtube/commands/_shared/ask-provider", () => ({
    loadAskProviderChoice: async () => ({ provider: { name: "fake" }, model: { id: "fake-model" } }),
}));

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        videos: {
            list: () => videos,
        },
        summary: {
            summarize: async (opts: unknown) => {
                calls.summarize.push(opts);
                const mode = (opts as { mode: "short" | "timestamped" }).mode;

                if (mode === "timestamped") {
                    return {
                        timestamped: [
                            { startSec: 0, endSec: 90, text: "Timestamped summary" },
                        ] as TimestampedSummaryEntry[],
                    };
                }

                return { short: "Short summary" };
            },
        },
        // `--ask` now goes through `answerOverVideos` (the one answering path),
        // which checks for a stored transcript and for existing embeddings before
        // it indexes, then enriches citations with title/clock/deep-link. That
        // needs a `db`, which the old direct-`qa.ask` route did not.
        db: {
            getTranscript: () => ({ segments: [{ startSec: 0, endSec: 90, text: "hello" }] }),
            hasQaChunks: () => false,
            getVideosByIds: (ids: string[]) => ids.map((id) => ({ id, title: "Fake video", uploadDate: null })),
        },
        qa: {
            index: async (opts: unknown) => {
                calls.index.push(opts);
                return { indexed: 1, modelId: "fake" };
            },
            ask: async (opts: unknown): Promise<AskResult> => {
                calls.ask.push(opts);
                return {
                    answer: "The answer",
                    citations: [
                        {
                            videoId: "abc123def45" as VideoId,
                            chunkIdx: 0,
                            startSec: 0,
                            endSec: 90,
                            source: "transcript" as const,
                            author: null,
                            commentId: null,
                        },
                    ],
                };
            },
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerAnalyzeCommand } = await import("@app/youtube/commands/analyze");
    const program = new Command().exitOverride().option("--json").option("--clipboard");
    registerAnalyzeCommand(program);

    return program;
}

describe("youtube analyze command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        calls.summarize = [];
        calls.index = [];
        calls.ask = [];
        stdout = "";
        stderr = "";
        process.exitCode = undefined;
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
        stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        });
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.exitCode = 0;
    });

    it("summarizes resolved video targets", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "analyze", "abc123def45", "--summary", "-y"]);

        expect(calls.summarize).toMatchObject([{ videoId: "abc123def45", mode: "short" }]);
        expect(stdout).toContain("Short summary");
    });

    it("summarizes channel targets with timestamped output", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "analyze", "@mkbhd", "--timestamped", "-y"]);

        expect(calls.summarize).toMatchObject([{ videoId: "abc123def45", mode: "timestamped" }]);
        expect(stdout).toContain("Timestamped summary");
    });

    it("indexes and asks across resolved targets", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "analyze",
            "abc123def45",
            "--ask",
            "what changed?",
            "--top-k",
            "4",
            "-y",
        ]);

        expect(calls.index).toMatchObject([{ videoId: "abc123def45" }]);
        expect(calls.ask[0]).toMatchObject({ videoIds: ["abc123def45"], question: "what changed?", topK: 4 });
        expect(stdout).toContain("The answer");
        // Enriched citations are the point of routing through the shared path:
        // human output prints the title and a deep link, where the old direct
        // call could only print `<videoId>#<chunkIdx>`.
        expect(stdout).toContain("Fake video");
        expect(stdout).toContain("watch?v=abc123def45");
    });

    it("rejects ask combined with summary flags", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "analyze", "abc123def45", "--summary", "--ask", "what changed?"]);

        expect(stderr).toContain("--ask is mutually exclusive");
        expect(process.exitCode).toBe(1);
    });
});

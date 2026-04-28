import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ChannelHandle, Video, VideoId } from "@app/youtube/lib/types";
import { Command } from "commander";

const videos: Video[] = [
    {
        id: "abc123def45",
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
    list: [] as unknown[],
    search: [] as unknown[],
    searchMetadata: [] as unknown[],
};

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        videos: {
            list: (opts: unknown) => {
                calls.list.push(opts);

                return videos;
            },
            show: (id: VideoId) => videos.find((video) => video.id === id) ?? null,
            search: (query: string, opts: unknown) => {
                calls.search.push({ query, opts });

                return [{ videoId: "abc123def45", lang: "en", snippet: "phone transcript", rank: -1 }];
            },
            searchMetadata: (query: string, opts: unknown) => {
                calls.searchMetadata.push({ query, opts });

                return [
                    {
                        videoId: "abc123def45",
                        field: "title",
                        snippet: "iPhone review",
                        title: "iPhone review",
                        channelHandle: "@mkbhd",
                    },
                    {
                        videoId: "abc123def45",
                        field: "description",
                        snippet: "A detailed phone review",
                        title: "iPhone review",
                        channelHandle: "@mkbhd",
                    },
                ];
            },
        },
        db: {
            getTranscript: (id: VideoId) => ({
                id: 1,
                videoId: id,
                lang: "en",
                source: "captions",
                text: "phone transcript",
                segments: [],
                durationSec: null,
                createdAt: "now",
            }),
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerVideosCommand } = await import("@app/youtube/commands/videos");
    const program = new Command().exitOverride().option("--json").option("--clipboard");
    registerVideosCommand(program);

    return program;
}

describe("youtube videos command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        calls.list = [];
        calls.search = [];
        calls.searchMetadata = [];
        stdout = "";
        stderr = "";
        process.exitCode = undefined;
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
        stderrSpy = spyOn(console, "error").mockImplementation((chunk?: unknown) => {
            stderr += `${String(chunk)}\n`;
        });
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.exitCode = 0;
    });

    it("passes list filters to the facade", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "videos",
            "list",
            "--channel",
            "mkbhd",
            "--since",
            "2026-01-01",
            "--limit",
            "5",
            "--include-shorts",
        ]);

        expect(calls.list[0]).toEqual({ channel: "@mkbhd", since: "2026-01-01", limit: 5, includeShorts: true });
        expect(stdout).toContain("iPhone review");
    });

    it("shows video details and transcript availability", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "videos", "show", "abc123def45"]);

        expect(stdout).toContain("iPhone review");
        expect(stdout).toContain("Transcript");
    });

    it("sets exit code for unknown videos", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "videos", "show", "missing00000"]);

        expect(stderr).toContain("Unknown video: missing00000");
        expect(process.exitCode).toBe(1);
    });

    it("searches transcripts and metadata fields server-side", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "videos",
            "search",
            "phone",
            "--in",
            "transcript,title,desc",
            "--channel",
            "mkbhd",
            "--limit",
            "10",
        ]);

        expect(calls.search[0]).toEqual({ query: "phone", opts: { limit: 10 } });
        expect(calls.searchMetadata[0]).toMatchObject({
            query: "phone",
            opts: { fields: ["title", "description"], channel: "@mkbhd", limit: 10 },
        });
        expect(calls.list).toEqual([]);
        expect(stdout).toContain("transcript");
        expect(stdout).toContain("title");
        expect(stdout).toContain("description");
    });
});

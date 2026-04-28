import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ChannelHandle, PipelineJob, Video, VideoId } from "@app/youtube/lib/types";
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
        audioPath: "/tmp/audio.opus",
        audioSizeBytes: 1024,
        audioCachedAt: "2026-04-01",
        videoPath: "/tmp/video.mp4",
        videoSizeBytes: 2048,
        videoCachedAt: "2026-04-01",
        thumbPath: null,
        thumbCachedAt: null,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
    },
];

const jobs: PipelineJob[] = [
    {
        id: 1,
        targetKind: "video",
        target: "abc123def45",
        stages: ["metadata"],
        currentStage: null,
        status: "completed",
        error: null,
        progress: 1,
        progressMessage: null,
        parentJobId: null,
        workerId: null,
        claimedAt: null,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
        completedAt: "2026-04-01",
    },
];

const calls = {
    prune: [] as unknown[],
    setPath: [] as unknown[],
};

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        channels: {
            list: () => [{ handle: "@mkbhd" }],
        },
        videos: {
            list: () => videos,
        },
        pipeline: {
            listJobs: () => jobs,
        },
        db: {
            listChannels: () => [{ handle: "@mkbhd" }],
            listTranscripts: () => [{ id: 1 }],
            pruneExpiredBinaries: async (opts: unknown) => {
                calls.prune.push(opts);
                return { audio: 1, video: 2, thumb: 3 };
            },
            setVideoBinaryPath: (...args: unknown[]) => {
                calls.setPath.push(args);
            },
        },
        config: {
            get: async () => ({ audio: "30 days", video: "7 days", thumb: "14 days", channelListing: "12 hours" }),
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerCacheCommand } = await import("@app/youtube/commands/cache");
    const program = new Command().exitOverride().option("--json").option("--clipboard");
    registerCacheCommand(program);

    return program;
}

describe("youtube cache command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        calls.prune = [];
        calls.setPath = [];
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

    it("prints cache stats", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "cache", "stats"]);

        expect(stdout).toContain("Cache stats");
        expect(stdout).toContain("channels:    1");
        expect(stdout).toContain("audio cache: 1.0 KB");
    });

    it("prunes expired binaries using configured TTLs", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "cache", "prune"]);

        expect(calls.prune[0]).toEqual({ audioOlderThanDays: 30, videoOlderThanDays: 7, thumbOlderThanDays: 14 });
        expect(stdout).toContain("Pruned 1 audio");
    });

    it("supports prune dry-run", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "cache", "prune", "--dry-run"]);

        expect(calls.prune).toEqual([]);
        expect(stdout).toContain("dry run");
    });

    it("clears selected cache kinds with --yes", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "cache", "clear", "--audio", "--yes"]);

        expect(calls.setPath).toEqual([["abc123def45", "audio", null]]);
        expect(stdout).toContain("Deleted 1 file");
    });

    it("rejects clear without selected kind", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "cache", "clear", "--yes"]);

        expect(stderr).toContain("Specify --audio, --video, --thumbs, or --all");
        expect(process.exitCode).toBe(1);
    });
});

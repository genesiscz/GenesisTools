import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import {
    checkYtDlp,
    downloadAudio,
    downloadVideo,
    dumpVideoMetadata,
    listChannelVideos,
} from "@app/youtube/lib/yt-dlp";

const encoder = new TextEncoder();

const spawnCalls: string[][] = [];

function textStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

function mockProcess(stdout: string, stderr = "", exitCode = 0): ReturnType<typeof Bun.spawn> {
    return {
        stdout: textStream(stdout),
        stderr: textStream(stderr),
        exited: Promise.resolve(exitCode),
        exitCode,
    } as ReturnType<typeof Bun.spawn>;
}

afterEach(() => {
    spawnCalls.length = 0;
});

describe("checkYtDlp", () => {
    it("returns the installed version when yt-dlp is available", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            spawnCalls.push(cmd as string[]);

            return mockProcess("2026.04.01\n");
        });

        await expect(checkYtDlp()).resolves.toEqual({ available: true, version: "2026.04.01" });
        expect(spawnCalls[0]).toEqual(["yt-dlp", "--version"]);
    });

    it("returns unavailable when spawning fails", async () => {
        spyOn(Bun, "spawn").mockImplementation(() => {
            throw new Error("missing binary");
        });

        await expect(checkYtDlp()).resolves.toEqual({ available: false, version: null });
    });
});

describe("listChannelVideos", () => {
    it("queries /videos and /streams tabs and tags entries appropriately", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            const args = cmd as string[];
            spawnCalls.push(args);
            const url = args[args.length - 1];

            if (url.endsWith("/streams")) {
                return mockProcess(
                    `${SafeJSON.stringify({ id: "live1234567", title: "Stream", duration: 3600, live_status: "was_live" })}\n`
                );
            }

            return mockProcess(
                `${[
                    SafeJSON.stringify({ id: "abc123def45", title: "One", duration: 123, upload_date: "20260401" }),
                    SafeJSON.stringify({ id: "def456ghi78", title: "Live", live_status: "is_live" }),
                ].join("\n")}\n`
            );
        });

        const result = await listChannelVideos({ handle: "@mkbhd", limit: 2, sinceUploadDate: "2026-01-02" });
        expect(result).toEqual([
            {
                id: "abc123def45",
                title: "One",
                durationSec: 123,
                uploadDate: "2026-04-01",
                isShort: false,
                isLive: false,
            },
            { id: "def456ghi78", title: "Live", durationSec: null, uploadDate: null, isShort: false, isLive: true },
            { id: "live1234567", title: "Stream", durationSec: 3600, uploadDate: null, isShort: false, isLive: false },
        ]);
        expect(spawnCalls).toHaveLength(2);
        expect(spawnCalls[0]).toContain("--playlist-end");
        expect(spawnCalls[0]).toContain("2");
        expect(spawnCalls[0]).toContain("--dateafter");
        expect(spawnCalls[0]).toContain("20260102");
        expect(spawnCalls[0]).toContain("--print");
        expect(spawnCalls[0][spawnCalls[0].length - 1]).toBe("https://www.youtube.com/@mkbhd/videos");
        expect(spawnCalls[1][spawnCalls[1].length - 1]).toBe("https://www.youtube.com/@mkbhd/streams");
    });

    it("queries /shorts in addition when includeShorts is true and tags shorts", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            const args = cmd as string[];
            spawnCalls.push(args);
            const url = args[args.length - 1];

            if (url.endsWith("/shorts")) {
                return mockProcess(`${SafeJSON.stringify({ id: "short123456", title: "Short", duration: 32 })}\n`);
            }
            if (url.endsWith("/streams")) {
                return mockProcess("");
            }

            return mockProcess(`${SafeJSON.stringify({ id: "long1234567", title: "Long", duration: 300 })}\n`);
        });

        const result = await listChannelVideos({ handle: "@mkbhd", includeShorts: true });
        expect(result).toEqual([
            { id: "long1234567", title: "Long", durationSec: 300, uploadDate: null, isShort: false, isLive: false },
            { id: "short123456", title: "Short", durationSec: 32, uploadDate: null, isShort: true, isLive: false },
        ]);
        expect(spawnCalls).toHaveLength(3);
        const urls = spawnCalls.map((args) => args[args.length - 1]);
        expect(urls).toContain("https://www.youtube.com/@mkbhd/videos");
        expect(urls).toContain("https://www.youtube.com/@mkbhd/streams");
        expect(urls).toContain("https://www.youtube.com/@mkbhd/shorts");
    });

    it("returns successful tabs and skips failed tabs without throwing", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            const args = cmd as string[];
            const url = args[args.length - 1];

            if (url.endsWith("/streams")) {
                return mockProcess("", "no channel streams", 1);
            }

            return mockProcess(`${SafeJSON.stringify({ id: "abc123def45", title: "Only Video" })}\n`);
        });

        const result = await listChannelVideos({ handle: "@missing" });
        expect(result).toEqual([
            {
                id: "abc123def45",
                title: "Only Video",
                durationSec: null,
                uploadDate: null,
                isShort: false,
                isLive: false,
            },
        ]);
    });
});

describe("dumpVideoMetadata", () => {
    it("parses yt-dlp dump JSON into normalized metadata", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            spawnCalls.push(cmd as string[]);

            return mockProcess(
                SafeJSON.stringify({
                    id: "abc123def45",
                    title: "A video",
                    description: "Description",
                    upload_date: "20260402",
                    duration: 59,
                    view_count: 1000,
                    like_count: 100,
                    language: "en",
                    subtitles: { en: [] },
                    automatic_captions: { cs: [] },
                    tags: ["tech"],
                    aspect_ratio: 0.56,
                    is_live: false,
                    thumbnail: "https://img.example/thumb.jpg",
                    uploader_id: "@mkbhd",
                    channel_id: "UCBJycsmduvYEL83R_U4JriQ",
                    channel: "MKBHD",
                })
            );
        });

        await expect(dumpVideoMetadata("abc123def45")).resolves.toEqual({
            id: "abc123def45",
            title: "A video",
            description: "Description",
            uploadDate: "2026-04-02",
            durationSec: 59,
            viewCount: 1000,
            likeCount: 100,
            language: "en",
            availableCaptionLangs: ["en", "cs"],
            tags: ["tech"],
            isShort: true,
            isLive: false,
            thumbUrl: "https://img.example/thumb.jpg",
            channelHandle: "@mkbhd",
            channelId: "UCBJycsmduvYEL83R_U4JriQ",
            channelTitle: "MKBHD",
        });
        expect(spawnCalls[0]).toEqual([
            "yt-dlp",
            "--skip-download",
            "--dump-json",
            "--no-warnings",
            "https://www.youtube.com/watch?v=abc123def45",
        ]);
    });

    it("throws stderr when metadata dumping fails", async () => {
        spyOn(Bun, "spawn").mockImplementation(() => mockProcess("", "bad video", 1));

        await expect(dumpVideoMetadata("bad")).rejects.toThrow("yt-dlp dumpVideoMetadata failed: bad video");
    });
});

describe("downloadAudio and downloadVideo", () => {
    it("downloads wav audio and emits download/postprocess progress", async () => {
        const dir = await mkdtemp(join(tmpdir(), "yt-dlp-test-"));
        const outPath = join(dir, "audio.wav");
        const progress: unknown[] = [];

        try {
            spyOn(Bun, "spawn").mockImplementation((cmd) => {
                const args = cmd as string[];
                spawnCalls.push(args);
                writeFileSync(outPath, "audio");

                return mockProcess("", "[download] 12.5% of 1MiB\n[ExtractAudio] Destination: audio.wav\n");
            });

            await expect(
                downloadAudio({
                    idOrUrl: "abc123def45",
                    outPath,
                    format: "wav",
                    onProgress: (info) => progress.push(info),
                })
            ).resolves.toEqual({
                path: outPath,
                sizeBytes: 5,
                durationSec: null,
            });
            expect(spawnCalls[0]).toEqual([
                "yt-dlp",
                "-x",
                "--no-playlist",
                "--newline",
                "-o",
                outPath,
                "--audio-format",
                "wav",
                "--postprocessor-args",
                "ffmpeg:-ar 16000 -ac 1",
                "abc123def45",
            ]);
            expect(progress).toEqual([
                { phase: "download", percent: 12.5, message: "[download] 12.5% of 1MiB" },
                { phase: "postprocess", message: "[ExtractAudio] Destination: audio.wav" },
            ]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("downloads opus audio with bitrate", async () => {
        const dir = await mkdtemp(join(tmpdir(), "yt-dlp-test-"));
        const outPath = join(dir, "audio.opus");

        try {
            spyOn(Bun, "spawn").mockImplementation((cmd) => {
                spawnCalls.push(cmd as string[]);
                writeFileSync(outPath, "opus");

                return mockProcess("");
            });

            await expect(
                downloadAudio({ idOrUrl: "abc123def45", outPath, format: "opus", bitrate: 96 })
            ).resolves.toMatchObject({ path: outPath, sizeBytes: 4 });
            expect(spawnCalls[0]).toContain("--audio-quality");
            expect(spawnCalls[0]).toContain("96K");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("downloads video using quality filters and emits merge progress", async () => {
        const dir = await mkdtemp(join(tmpdir(), "yt-dlp-test-"));
        const outPath = join(dir, "video.mp4");
        const progress: unknown[] = [];

        try {
            spyOn(Bun, "spawn").mockImplementation((cmd) => {
                spawnCalls.push(cmd as string[]);
                writeFileSync(outPath, "video");

                return mockProcess("", "[download] 90% of 10MiB\n[Merger] Merging formats into video.mp4\n");
            });

            await expect(
                downloadVideo({
                    idOrUrl: "abc123def45",
                    outPath,
                    quality: "720p",
                    onProgress: (info) => progress.push(info),
                })
            ).resolves.toEqual({
                path: outPath,
                sizeBytes: 5,
            });
            expect(spawnCalls[0]).toContain("bv*[height<=720]+ba/b[height<=720]");
            expect(progress).toEqual([
                { phase: "download", percent: 90, message: "[download] 90% of 10MiB" },
                { phase: "merge", message: "[Merger] Merging formats into video.mp4" },
            ]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("throws stderr when downloads fail", async () => {
        const dir = await mkdtemp(join(tmpdir(), "yt-dlp-test-"));
        const outPath = join(dir, "video.mp4");

        try {
            spyOn(Bun, "spawn").mockImplementation(() => mockProcess("", "download failed", 1));

            await expect(downloadVideo({ idOrUrl: "bad", outPath, quality: "best" })).rejects.toThrow(
                "yt-dlp downloadVideo failed: download failed"
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { checkYtDlp, dumpVideoMetadata, listChannelVideos } from "@app/youtube/lib/yt-dlp";

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
    it("parses flat playlist JSON and excludes shorts by default", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            const args = cmd as string[];
            spawnCalls.push(args);

            expect(args).toContain("--match-filter");
            expect(args).toContain("!is_short");

            return mockProcess(JSON.stringify({
                entries: [
                    { id: "abc123def45", title: "One", duration: 123, upload_date: "20260401", live_status: "not_live" },
                    { id: "def456ghi78", title: "Live", live_status: "is_live" },
                ],
            }));
        });

        await expect(listChannelVideos({ handle: "@mkbhd", limit: 2, sinceUploadDate: "2026-01-02" })).resolves.toEqual([
            { id: "abc123def45", title: "One", durationSec: 123, uploadDate: "2026-04-01", isShort: false, isLive: false },
            { id: "def456ghi78", title: "Live", durationSec: null, uploadDate: null, isShort: false, isLive: true },
        ]);
        expect(spawnCalls[0]).toContain("--playlist-end");
        expect(spawnCalls[0]).toContain("2");
        expect(spawnCalls[0]).toContain("--dateafter");
        expect(spawnCalls[0]).toContain("20260102");
    });

    it("runs a second shorts pass when includeShorts is true", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            const args = cmd as string[];
            spawnCalls.push(args);
            const isShortsPass = args.includes("is_short");

            if (isShortsPass) {
                return mockProcess(JSON.stringify({ entries: [{ id: "short123456", title: "Short", duration: 32, upload_date: "20260303" }] }));
            }

            return mockProcess(JSON.stringify({ entries: [{ id: "long1234567", title: "Long", duration: 300, upload_date: "20260302" }] }));
        });

        await expect(listChannelVideos({ handle: "@mkbhd", includeShorts: true })).resolves.toEqual([
            { id: "long1234567", title: "Long", durationSec: 300, uploadDate: "2026-03-02", isShort: false, isLive: false },
            { id: "short123456", title: "Short", durationSec: 32, uploadDate: "2026-03-03", isShort: true, isLive: false },
        ]);
        expect(spawnCalls).toHaveLength(2);
        expect(spawnCalls[1]).toContain("is_short");
    });

    it("throws stderr when yt-dlp listing fails", async () => {
        spyOn(Bun, "spawn").mockImplementation(() => mockProcess("", "no channel", 1));

        await expect(listChannelVideos({ handle: "@missing" })).rejects.toThrow("yt-dlp listChannelVideos failed: no channel");
    });
});

describe("dumpVideoMetadata", () => {
    it("parses yt-dlp dump JSON into normalized metadata", async () => {
        spyOn(Bun, "spawn").mockImplementation((cmd) => {
            spawnCalls.push(cmd as string[]);

            return mockProcess(JSON.stringify({
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
            }));
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
        expect(spawnCalls[0]).toEqual(["yt-dlp", "--skip-download", "--dump-json", "--no-warnings", "abc123def45"]);
    });

    it("throws stderr when metadata dumping fails", async () => {
        spyOn(Bun, "spawn").mockImplementation(() => mockProcess("", "bad video", 1));

        await expect(dumpVideoMetadata("bad")).rejects.toThrow("yt-dlp dumpVideoMetadata failed: bad video");
    });
});

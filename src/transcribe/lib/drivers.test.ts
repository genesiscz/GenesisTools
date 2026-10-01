import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

import { acquireRemoteAudio, fetchXDurationSec, type MediaFetch } from "./acquire.ts";
import { classifySource, pickMp4Variant, xDurationSec, xSyndicationUrl } from "./drivers.ts";

const POTETO = "https://x.com/poteto/status/2102050467505430555";
const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("classifySource", () => {
    it("routes a YouTube watch URL and a bare id to the youtube driver", () => {
        expect(classifySource("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
            driver: "youtube",
            videoId: "dQw4w9WgXcQ",
        });
        expect(classifySource("https://youtu.be/dQw4w9WgXcQ")).toEqual({
            driver: "youtube",
            videoId: "dQw4w9WgXcQ",
        });
        expect(classifySource("https://youtube.com/shorts/dQw4w9WgXcQ")).toEqual({
            driver: "youtube",
            videoId: "dQw4w9WgXcQ",
        });
        expect(classifySource("dQw4w9WgXcQ")).toEqual({ driver: "youtube", videoId: "dQw4w9WgXcQ" });
    });

    it("routes an X or Twitter status URL to the x driver", () => {
        expect(classifySource(POTETO)).toEqual({
            driver: "x",
            statusId: "2102050467505430555",
            url: POTETO,
        });
        expect(classifySource("https://mobile.twitter.com/poteto/status/2102050467505430555?s=20")).toMatchObject({
            driver: "x",
            statusId: "2102050467505430555",
        });
    });

    it("rejects an X profile and a YouTube channel", () => {
        expect(classifySource("https://x.com/poteto").driver).toBe("unsupported");
        expect(classifySource("https://youtube.com/@poteto").driver).toBe("unsupported");
    });

    it("routes a media file URL to the direct driver and a local path to local", () => {
        expect(classifySource("https://video.twimg.com/amplify_video/x/vid/avc1/430x270/clip.mp4")).toMatchObject({
            driver: "direct",
        });
        expect(classifySource("https://cdn.example.com/talk.m3u8").driver).toBe("direct");
        expect(classifySource("/tmp/meeting.m4a")).toEqual({ driver: "local" });
    });
});

describe("xDurationSec", () => {
    it("reads duration_millis and does not need a media url", () => {
        expect(
            xDurationSec({
                mediaDetails: [{ video_info: { duration_millis: 2_281_984, variants: [] } }],
            })
        ).toBeCloseTo(2281.984, 3);
        expect(xDurationSec({ video: { durationMs: 2_281_984 } })).toBeCloseTo(2281.984, 3);
        expect(xDurationSec({ mediaDetails: [{ type: "photo" }] })).toBeNull();
    });

    it("fetches only the post json", async () => {
        const fetched: string[] = [];
        const seconds = await fetchXDurationSec("2102050467505430555", async (input) => {
            fetched.push(String(input));

            return json({ mediaDetails: [{ video_info: { duration_millis: 2_281_984 } }] });
        });

        expect(seconds).toBeCloseTo(2281.984, 3);
        expect(fetched).toEqual([xSyndicationUrl("2102050467505430555")]);
    });
});

describe("pickMp4Variant", () => {
    it("picks the lowest bitrate mp4 and ignores the hls playlist", () => {
        const picked = pickMp4Variant({
            mediaDetails: [
                {
                    type: "video",
                    video_info: {
                        variants: [
                            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/pl/x.m3u8" },
                            { bitrate: 25_128_000, content_type: "video/mp4", url: "https://video.twimg.com/4k.mp4" },
                            { bitrate: 256_000, content_type: "video/mp4", url: "https://video.twimg.com/small.mp4" },
                            { bitrate: 832_000, content_type: "video/mp4", url: "https://video.twimg.com/mid.mp4" },
                        ],
                    },
                },
            ],
        });

        expect(picked).toEqual({ url: "https://video.twimg.com/small.mp4", bitrate: 256_000 });
    });

    it("picks within the first video, never another video's smaller rendition", () => {
        const picked = pickMp4Variant({
            mediaDetails: [
                {
                    type: "video",
                    video_info: {
                        variants: [
                            { bitrate: 832_000, content_type: "video/mp4", url: "https://video.twimg.com/a.mp4" },
                        ],
                    },
                },
                {
                    type: "video",
                    video_info: {
                        variants: [
                            { bitrate: 256_000, content_type: "video/mp4", url: "https://video.twimg.com/b.mp4" },
                        ],
                    },
                },
            ],
        });

        expect(picked).toEqual({ url: "https://video.twimg.com/a.mp4", bitrate: 832_000 });
    });

    it("returns null when the post has no video", () => {
        expect(pickMp4Variant({ mediaDetails: [{ type: "photo" }] })).toBeNull();
        expect(pickMp4Variant(null)).toBeNull();
    });
});

describe("acquireRemoteAudio", () => {
    it("downloads the small x mp4 and extracts audio", async () => {
        const dir = await tempDir();
        const fetched: string[] = [];
        const converted: string[] = [];
        const acquired = await acquireRemoteAudio(
            { driver: "x", statusId: "2102050467505430555", url: POTETO },
            {
                dir,
                fetch: async (input) => {
                    const url = String(input);
                    fetched.push(url);

                    if (url === xSyndicationUrl("2102050467505430555")) {
                        return json({
                            mediaDetails: [
                                {
                                    video_info: {
                                        variants: [
                                            {
                                                bitrate: 256_000,
                                                content_type: "video/mp4",
                                                url: "https://video.twimg.com/small.mp4",
                                            },
                                            {
                                                bitrate: 10_000_000,
                                                content_type: "video/mp4",
                                                url: "https://video.twimg.com/huge.mp4",
                                            },
                                        ],
                                    },
                                },
                            ],
                        });
                    }

                    return new Response(new Uint8Array([1, 2, 3, 4]), {
                        headers: { "content-type": "video/mp4" },
                    });
                },
                convert: async (input, output) => {
                    converted.push(input);
                    await Bun.write(output, "audio");

                    return output;
                },
            }
        );

        expect(fetched[0]).toBe(xSyndicationUrl("2102050467505430555"));
        expect(fetched[1]).toBe("https://video.twimg.com/small.mp4");
        expect(converted).toHaveLength(1);
        expect(await Bun.file(acquired.audioPath).text()).toBe("audio");
        await acquired.cleanup();
    });

    it("keeps a direct mp3 without transcoding", async () => {
        const dir = await tempDir();
        let converted = false;
        const acquired = await acquireRemoteAudio(
            { driver: "direct", url: "https://cdn.example.com/talk.mp3" },
            {
                dir,
                fetch: async () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }),
                convert: async () => {
                    converted = true;

                    return "";
                },
            }
        );

        expect(converted).toBe(false);
        expect(acquired.audioPath.endsWith(".mp3")).toBe(true);
        expect(new Uint8Array(await Bun.file(acquired.audioPath).arrayBuffer())).toEqual(new Uint8Array([9, 9]));
        await acquired.cleanup();
    });

    it("refuses an html page on the direct driver", async () => {
        const dir = await tempDir();
        await expect(
            acquireRemoteAudio(
                { driver: "direct", url: "https://example.com/watch" },
                {
                    dir,
                    fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
                }
            )
        ).rejects.toThrow(/not a video or audio file/);
    });

    it("reuses a converted file for one hour instead of downloading again", async () => {
        const work = await tempDir();
        const cache = await tempDir();
        let fetches = 0;
        const fetchImpl: MediaFetch = async (input) => {
            fetches += 1;
            const url = String(input);

            if (url === xSyndicationUrl("2102050467505430555")) {
                return json({
                    mediaDetails: [
                        {
                            video_info: {
                                variants: [
                                    {
                                        bitrate: 256_000,
                                        content_type: "video/mp4",
                                        url: "https://video.twimg.com/small.mp4",
                                    },
                                ],
                            },
                        },
                    ],
                });
            }

            return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
        };
        const convert = async (_input: string, output: string) => {
            await Bun.write(output, "cached-audio");

            return output;
        };
        const source = { driver: "x" as const, statusId: "2102050467505430555", url: POTETO };
        const first = await acquireRemoteAudio(source, { dir: work, cacheDir: cache, fetch: fetchImpl, convert });

        expect(fetches).toBe(2);
        expect(first.cached).toBe(false);
        fetches = 0;
        const second = await acquireRemoteAudio(source, {
            cacheDir: cache,
            fetch: async () => {
                fetches += 1;

                throw new Error("cache miss");
            },
        });

        expect(fetches).toBe(0);
        expect(second.cached).toBe(true);
        expect(await Bun.file(second.audioPath).text()).toBe("cached-audio");
        await first.cleanup();
        await second.cleanup();
    });

    it("passes an hls playlist straight to ffmpeg", async () => {
        const dir = await tempDir();
        let fetched = false;
        let ffmpegInput = "";
        const acquired = await acquireRemoteAudio(
            { driver: "direct", url: "https://cdn.example.com/live.m3u8" },
            {
                dir,
                fetch: async () => {
                    fetched = true;

                    return new Response("");
                },
                convert: async (input, output) => {
                    ffmpegInput = input;
                    await Bun.write(output, "audio");

                    return output;
                },
            }
        );

        expect(fetched).toBe(false);
        expect(ffmpegInput).toBe("https://cdn.example.com/live.m3u8");
        expect(acquired.audioPath.endsWith("audio.mp3")).toBe(true);
        await acquired.cleanup();
    });

    it("an extensionless playlist, known by its Content-Type, goes to ffmpeg by its own URL", async () => {
        const dir = await tempDir();
        let ffmpegInput = "";
        const acquired = await acquireRemoteAudio(
            { driver: "direct", url: "https://cdn.example.com/stream" },
            {
                dir,
                fetch: async () =>
                    new Response("#EXTM3U\nseg1.ts\n", {
                        headers: { "content-type": "application/vnd.apple.mpegurl" },
                    }),
                convert: async (input, output) => {
                    ffmpegInput = input;
                    await Bun.write(output, "audio");

                    return output;
                },
            }
        );

        expect(ffmpegInput).toBe("https://cdn.example.com/stream");
        await acquired.cleanup();
    });
});

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "transcribe-driver-test-"));
    dirs.push(dir);

    return dir;
}

function json(body: unknown): Response {
    return new Response(SafeJSON.stringify(body), { headers: { "content-type": "application/json" } });
}

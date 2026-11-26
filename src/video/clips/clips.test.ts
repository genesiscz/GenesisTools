import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapPool } from "@genesiscz/utils/async";
import { fetchWithCheckedRedirects, readResponseTextBounded } from "@genesiscz/utils/http/checked-response";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { redactUrlQueries } from "@genesiscz/utils/video/process";
import { fetchKickText, kickTimeSchema, listKickVods, parseKickTarget, retryAfterMs, siteOffset } from "../kick/api";
import { fitVodStart, kickProvider, placeBySpan } from "../kick/provider";
import { listTwitchVods, parseTwitchTarget } from "../twitch/api";
import { clipFileName } from "./download";
import { requireProviderMediaUrl, requireRemoteHttpsUrl, validateProviderPlaylist, writeThenPublish } from "./files";
import { type FetchText, readVodPlayback, spanOf, variantName } from "./hls";
import { type ClipsManifest, findOverlaps, type ManifestClip, providerSection, recordClips } from "./manifest";
import { CLIP_PROVIDERS } from "./providers";
import type { Clip, ClipSource, Vod } from "./types";
import { vodPartFileName } from "./vod";

const CLIP = "clip_01M7RY9637GFHTX1SEQE9EWJ88";

function stubFetch(
    run: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

describe("remaining review regressions", () => {
    it("checks redirects before following them and bounds successful and error bodies", async () => {
        const calls: string[] = [];
        const fake = spyOn(globalThis, "fetch").mockImplementation(
            stubFetch(async (input) => {
                calls.push(String(input));
                return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
            })
        );
        try {
            await expect(
                fetchWithCheckedRedirects({
                    url: "https://cdn.example.com/a",
                    validate: (value) => {
                        requireRemoteHttpsUrl(value, "fixture");
                    },
                })
            ).rejects.toThrow("not https");
            expect(calls).toEqual(["https://cdn.example.com/a"]);
            await expect(readResponseTextBounded({ response: new Response("12345"), maxBytes: 4 })).rejects.toThrow(
                "exceeds 4"
            );
            expect(
                await readResponseTextBounded({ response: new Response("12345"), maxBytes: 4, truncate: true })
            ).toBe("1234");
        } finally {
            fake.mockRestore();
        }
    });

    it("keeps completed undefined pool values and stops scheduling after cancellation", async () => {
        expect(await mapPool({ items: [1, 2], jobs: 2, task: async () => undefined })).toEqual([undefined, undefined]);
        const stop = new AbortController();
        const values = await mapPool({
            items: [1, 2, 3],
            jobs: 1,
            signal: stop.signal,
            task: async () => {
                stop.abort();
                return undefined;
            },
        });
        expect(values).toEqual([undefined]);
    });

    it("accepts a falsy option and disambiguates playlist files sharing a folder", () => {
        expect(
            chooseQuality({
                options: [1, 0],
                quality: "zero",
                names: (value) => [value === 0 ? "zero" : "one"],
                height: (value) => value,
            })
        ).toBe(0);
        expect(
            chooseQuality({ options: [1, 0], quality: "0", names: () => ["source"], height: (value) => value })
        ).toBe(0);
        const variants = ["a.m3u8", "b.m3u8"].map((name) => ({
            uri: `https://cdn.example.com/720p/${name}`,
            bandwidth: 1000,
            height: 720,
            frameRate: 30,
        }));
        expect(variantName(variants[0], variants)).not.toBe(variantName(variants[1], variants));
    });

    it("refuses unsupported Twitch paths and trailing clip or VOD components", () => {
        for (const url of [
            "https://clips.twitch.tv/LongClipSlug/extra",
            "https://www.twitch.tv/videos/123456/extra",
            "https://www.twitch.tv/desk/clip/LongClipSlug/extra",
            "https://www.twitch.tv/desk/settings",
        ]) {
            expect(() => parseTwitchTarget(url)).toThrow();
        }
    });

    it("paginates Twitch VODs and rejects malformed timestamps with the shape diagnostic", async () => {
        const queries: string[] = [];
        const raw = (id: string) => ({ id, title: id, createdAt: "2026-01-01T00:00:00Z", lengthSeconds: 20 });
        let count = 0;
        const fake = spyOn(globalThis, "fetch").mockImplementation(
            stubFetch(async (_input, init) => {
                queries.push(String(init?.body));
                count++;
                return Response.json({
                    data: {
                        user: {
                            videos: {
                                edges: [{ cursor: `cursor${count}`, node: raw(String(count)) }],
                                pageInfo: { hasNextPage: count < 2 },
                            },
                        },
                    },
                });
            })
        );
        try {
            expect((await listTwitchVods("desk")).map((vod) => vod.id)).toEqual(["1", "2"]);
            expect(queries[1]).toContain("cursor1");
            fake.mockImplementation(
                stubFetch(async () =>
                    Response.json({
                        data: {
                            user: {
                                videos: {
                                    edges: [{ cursor: "last", node: { ...raw("3"), createdAt: "tomorrow" } }],
                                    pageInfo: { hasNextPage: false },
                                },
                            },
                        },
                    })
                )
            );
            await expect(listTwitchVods("desk")).rejects.toThrow("changed shape");
        } finally {
            fake.mockRestore();
        }
    });

    it("keeps an explicit Kick private flag and falls back to the site offset after a CDN failure", async () => {
        const fake = spyOn(globalThis, "fetch").mockImplementation(
            stubFetch(async () =>
                Response.json([
                    {
                        id: 100,
                        is_live: false,
                        duration: 100000,
                        start_time: "2026-01-01 00:00:00",
                        source: "https://cdn.example.com/video.m3u8",
                        video: { uuid: "a1c8e6f0-a768-4ef9-b7bb-c0de5c52d30e", is_private: true, status: "public" },
                    },
                ])
            )
        );
        try {
            const info = (await listKickVods("desk"))[0];
            expect(info.vod.access).toBe("private");
            expect(info.playlistUrl).toBeNull();
            fake.mockImplementation(stubFetch(async () => new Response("unavailable", { status: 503 })));
            await expect(fetchKickText("https://clips.kick.com/a.m3u8?token=fixture-secret")).rejects.toThrow(
                "https://clips.kick.com/a.m3u8?[redacted]"
            );
            const c = { ...kickClip(), vodOffsetSec: 25, streamId: "100" };
            const placed = await kickProvider.placeClips({
                clips: [c],
                jobs: 1,
                vod: {
                    vod: info.vod,
                    playback: {
                        variantUrl: "https://cdn.example.com/v.m3u8",
                        variantName: "source",
                        startAt: null,
                        bandwidth: 1000,
                        durationSec: 100,
                    },
                },
            });
            expect(placed.sources.get(c.id)).toMatchObject({ offsetFrom: "site", vodOffsetSec: 25, startAt: null });
        } finally {
            fake.mockRestore();
        }
    });
});

describe("parseKickTarget", () => {
    it("reads a VOD page and a bare VOD uuid", () => {
        const uuid = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
        expect(parseKickTarget(`https://kick.com/somechannel/videos/${uuid}`)).toEqual({ kind: "vod", id: uuid });
        expect(parseKickTarget(uuid.toUpperCase())).toEqual({ kind: "vod", id: uuid });
    });

    it("reads a clip from its page URL, its query form and its bare id", () => {
        expect(parseKickTarget(`https://kick.com/somechannel/clips/${CLIP}`)).toEqual({ kind: "clip", id: CLIP });
        expect(parseKickTarget(`https://kick.com/somechannel?clip=${CLIP}`)).toEqual({ kind: "clip", id: CLIP });
        expect(parseKickTarget(CLIP.toLowerCase())).toEqual({ kind: "clip", id: CLIP });
    });

    it("reads a clips page with the page's own sort and range", () => {
        expect(parseKickTarget("https://kick.com/SomeChannel/clips?sort=date&range=day")).toEqual({
            kind: "channel",
            channel: "somechannel",
            sort: "date",
            range: "day",
        });
    });

    it("reads a channel page and a bare slug, and ignores unknown filter values", () => {
        expect(parseKickTarget("kick.com/somechannel?sort=hot")).toEqual({ kind: "channel", channel: "somechannel" });
        expect(parseKickTarget("some_channel")).toEqual({ kind: "channel", channel: "some_channel" });
    });

    it("refuses another site and a kick.com path that names no channel", () => {
        expect(() => parseKickTarget("https://example.com/somechannel/clips")).toThrow("not a kick.com URL");
        expect(() => parseKickTarget("https://kick.com/categories/games")).toThrow("names no Kick channel");
    });

    it("refuses a clip id inside another site's URL and a malformed clip or VOD path", () => {
        expect(() => parseKickTarget(`https://example.com/x?clip=${CLIP}`)).toThrow("not a kick.com URL");
        expect(() => parseKickTarget("https://kick.com/somechannel/clips/clip_INVALID")).toThrow("names no Kick clip");
        expect(() => parseKickTarget("https://kick.com/somechannel/videos/not-a-uuid")).toThrow("names no Kick VOD");
        expect(() => parseKickTarget("https://kick.com/somechannel?clip=nope")).toThrow("names no Kick clip");
        expect(() => parseKickTarget(`https://kick.com/somechannel/about/${CLIP}`)).toThrow("is not a Kick");
        expect(parseKickTarget("https://kick.com/somechannel/videos")).toEqual({
            kind: "channel",
            channel: "somechannel",
        });
    });
});

describe("parseTwitchTarget", () => {
    it("reads clip URLs and bare clip slugs", () => {
        const slug = "SomeCamelCaseClipName-a1B2c3D4e5F6g7H8";
        expect(parseTwitchTarget(`https://www.twitch.tv/somechannel/clip/${slug}`)).toEqual({ kind: "clip", id: slug });
        expect(parseTwitchTarget(`https://clips.twitch.tv/${slug}`)).toEqual({ kind: "clip", id: slug });
        expect(parseTwitchTarget(slug)).toEqual({ kind: "clip", id: slug });
        expect(parseTwitchTarget("AnOldClipSlugLongerThanALogin")).toEqual({
            kind: "clip",
            id: "AnOldClipSlugLongerThanALogin",
        });
    });

    it("reads VOD URLs and ids, clips pages with their range, and logins", () => {
        expect(parseTwitchTarget("https://www.twitch.tv/videos/1234567890")).toEqual({ kind: "vod", id: "1234567890" });
        expect(parseTwitchTarget("1234567890")).toEqual({ kind: "vod", id: "1234567890" });
        expect(parseTwitchTarget("https://www.twitch.tv/SomeChannel/clips?filter=clips&range=7d")).toEqual({
            kind: "channel",
            channel: "somechannel",
            range: "week",
        });
        expect(parseTwitchTarget("some_channel")).toEqual({ kind: "channel", channel: "some_channel" });
        expect(() => parseTwitchTarget("https://www.twitch.tv/directory/all")).toThrow("names no Twitch channel");
        expect(() => parseTwitchTarget("https://www.twitch.tv/somechannel/clip/")).toThrow("names no Twitch clip");
        expect(() => parseTwitchTarget("https://www.twitch.tv/somechannel/clip/bad%20slug")).toThrow(
            "names no Twitch clip"
        );
    });
});

describe("Kick API answers", () => {
    it("reads a list time as UTC and keeps the zone of a detail time; a non-date is a schema issue", () => {
        expect(kickTimeSchema.parse("2026-11-19 17:28:55")).toBe("2026-11-19T17:28:55.000Z");
        expect(kickTimeSchema.parse("2026-11-19 17:28:55+00:00")).toBe("2026-11-19T17:28:55.000Z");
        expect(kickTimeSchema.parse("2026-11-19T18:28:55+01:00")).toBe("2026-11-19T17:28:55.000Z");
        expect(kickTimeSchema.safeParse("soon").success).toBe(false);
    });

    it("waits as long as Retry-After asks, and doubles up to 30 s without it", () => {
        expect(retryAfterMs("300", 0)).toBe(300_000);
        expect(retryAfterMs("Thu, 19 Nov 2026 00:01:00 GMT", 0, Date.parse("2026-11-19T00:00:00Z"))).toBe(60_000);
        expect(retryAfterMs(null, 1)).toBe(4000);
        expect(retryAfterMs(null, 6)).toBe(30_000);
    });
});

describe("file names from a site's answer", () => {
    it("keep every API part inside the folder", () => {
        const name = clipFileName(CLIP_PROVIDERS.kick, {
            ...kickClip(),
            channel: "../../etc",
            createdAt: "../x/2026-11-19",
            id: "clip_../../a",
        });
        expect(name).not.toContain("/");
        expect(name.startsWith(".")).toBe(false);
    });

    it("name a VOD cut by its exact range, and leave the range out only for the whole VOD", () => {
        const vod: Vod = {
            provider: "kick",
            id: "a1c8e6f0-a768-4ef9-b7bb-c0de5c52d30e",
            streamId: "100",
            title: "stream",
            channel: "somechannel",
            startedAt: "2026-11-18T23:28:44.000Z",
            durationSec: 1000,
            live: false,
            access: "public",
            pageUrl: null,
        };
        const name = (fromSec: number, toSec: number) =>
            vodPartFileName({ vod, fromSec, toSec, playbackDurationSec: 1000, quality: "720p60" });

        expect(name(100.1, 110.1)).not.toBe(name(100.9, 110.9));
        expect(name(100.25, 110)).toContain("0-01-40.250_0-01-50");
        expect(name(0, 996)).not.toBe(name(0, 1000));
        expect(name(0, 1000)).toBe("somechannel-2026-11-18-stream-a1c8e6f0-a768-4ef9-b7bb-c0de5c52d30e-720p60.mp4");
    });
});

describe("media URLs and logs", () => {
    it("lets ffmpeg open only https on a public host", () => {
        expect(requireRemoteHttpsUrl("https://cdn.example.com/a.m3u8", "clip")).toBe("https://cdn.example.com/a.m3u8");
        expect(() => requireRemoteHttpsUrl("file:///etc/passwd", "clip")).toThrow("not https");
        expect(() => requireRemoteHttpsUrl("http://cdn.example.com/a.m3u8", "clip")).toThrow("not https");
        expect(() => requireRemoteHttpsUrl("https://127.0.0.1/a.m3u8", "clip")).toThrow("not https");
        expect(() => requireRemoteHttpsUrl("https://localhost/a.m3u8", "clip")).toThrow("not https");
    });

    it("restricts provider media and nested HLS requests to the supported CDN hosts", () => {
        expect(requireProviderMediaUrl("https://clips.kick.com/fixture.m3u8", "kick")).toContain("clips.kick.com");
        expect(() => requireProviderMediaUrl("https://example.com/a.m3u8", "kick")).toThrow("outside");
        expect(() =>
            validateProviderPlaylist(
                "#EXTM3U\n#EXTINF:4,\nhttps://127.0.0.1/segment.ts",
                "https://clips.kick.com/a.m3u8",
                "kick"
            )
        ).toThrow("not https");
        expect(() =>
            validateProviderPlaylist(
                '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"',
                "https://clips.kick.com/a.m3u8",
                "kick"
            )
        ).toThrow("outside");
    });

    it("shows a URL without its query in logs and errors", () => {
        expect(redactUrlQueries("ffmpeg -i https://cdn.example.com/a.mp4?sig=abc&token=xyz -c copy")).toBe(
            "ffmpeg -i https://cdn.example.com/a.mp4?[redacted] -c copy"
        );
    });
});

describe("writeThenPublish", () => {
    it("refuses exclusive publication when the filesystem cannot link without replacement", async () => {
        const dir = mkdtempSync(join(tmpdir(), "clips-no-link-"));
        const failure = spyOn(fs, "linkSync").mockImplementation(() => {
            throw Object.assign(new Error("no links"), { code: "ENOTSUP" });
        });
        try {
            const output = join(dir, "a.mp4");
            await expect(
                writeThenPublish({
                    output,
                    force: false,
                    write: async (part) => writeFileSync(part, "new"),
                })
            ).rejects.toThrow("cannot publish");
            expect(existsSync(output)).toBe(false);
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            failure.mockRestore();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("publishes a finished file, keeps a file that appeared meanwhile, and leaves no part behind on failure", async () => {
        const dir = mkdtempSync(join(tmpdir(), "clips-publish-"));

        try {
            const output = join(dir, "a.mp4");
            const saved = await writeThenPublish({
                output,
                force: false,
                write: async (part) => writeFileSync(part, "new"),
            });
            expect(saved).toBe("saved");

            const kept = await writeThenPublish({
                output,
                force: false,
                write: async (part) => writeFileSync(part, "other"),
            });
            expect([kept, readFileSync(output, "utf8")]).toEqual(["exists", "new"]);

            const forced = await writeThenPublish({
                output,
                force: true,
                write: async (part) => writeFileSync(part, "forced"),
            });
            expect([forced, readFileSync(output, "utf8")]).toEqual(["saved", "forced"]);

            const failed = writeThenPublish({
                output: join(dir, "b.mp4"),
                force: false,
                write: async (part) => {
                    writeFileSync(part, "half");
                    throw new Error("ffmpeg failed");
                },
            });
            await expect(failed).rejects.toThrow("ffmpeg failed");
            expect(existsSync(join(dir, "b.mp4"))).toBe(false);
            expect(readdirSync(dir)).toEqual(["a.mp4"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("VOD playlists", () => {
    const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1280x720,FRAME-RATE=60
720p60/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=30
720p30/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=30
720p30b/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="aud"
360p/index.m3u8
`;
    const MEDIA = `#EXTM3U
#EXTINF:2.000,
0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-11-19T00:00:02.000Z
#EXTINF:2.000,
1.ts
`;

    function site(files: Record<string, string>, redirect: Record<string, string> = {}) {
        const asked: string[] = [];
        const fetchText: FetchText = async (url) => {
            asked.push(url);
            const finalUrl = redirect[url] ?? url;
            const text = files[finalUrl];

            if (text === undefined) {
                throw new Error(`404 ${finalUrl}`);
            }

            return { text, url: finalUrl };
        };
        return { asked, fetchText };
    }

    it("counts the start back from the first program date time", () => {
        const { fetchText } = site({});
        expect(fetchText).toBeDefined();
        const playlist = {
            kind: "media" as const,
            targetDurationSec: 2,
            mediaSequence: 0,
            ended: true,
            usesByteRanges: false,
            segments: [
                { sequence: 0, uri: "a", durationSec: 2 },
                { sequence: 1, uri: "b", durationSec: 2, programDateTime: "2026-11-19T00:00:02.000Z" },
            ],
        };
        expect(spanOf(playlist)?.startAt).toBe("2026-11-19T00:00:00.000Z");
    });

    it("names equal-height variants apart, resolves them against the redirected URL, and refuses separate audio", async () => {
        const { asked, fetchText } = site(
            {
                "https://cdn.example.com/vod/master.m3u8": MASTER,
                "https://cdn.example.com/vod/720p30/index.m3u8": MEDIA,
            },
            { "https://api.example.com/master.m3u8": "https://cdn.example.com/vod/master.m3u8" }
        );
        const playback = await readVodPlayback({
            masterUrl: "https://api.example.com/master.m3u8",
            quality: "720p-720p30",
            fetchText,
        });

        expect([playback.variantName, playback.variantUrl, playback.startAt]).toEqual([
            "720p-720p30",
            "https://cdn.example.com/vod/720p30/index.m3u8",
            "2026-11-19T00:00:00.000Z",
        ]);
        expect(asked).toHaveLength(2);
        await expect(
            readVodPlayback({ masterUrl: "https://api.example.com/master.m3u8", quality: "360p", fetchText })
        ).rejects.toThrow("separate playlist");
    });

    it("reads a VOD URL that is already a media playlist once", async () => {
        const { asked, fetchText } = site({ "https://cdn.example.com/vod/index.m3u8": MEDIA });
        const playback = await readVodPlayback({ masterUrl: "https://cdn.example.com/vod/index.m3u8", fetchText });

        expect([playback.variantName, playback.durationSec, asked.length]).toEqual(["source", 4, 1]);
    });
});

function clip(id: string, fromSec: number, toSec: number, streamId = "s1"): ManifestClip {
    return {
        id,
        title: id,
        pageUrl: `https://example.com/${id}`,
        mediaUrl: `https://example.com/${id}.m3u8`,
        thumbnailUrl: null,
        channel: "somechannel",
        channelName: "SomeChannel",
        creator: null,
        category: null,
        mature: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        durationSec: toSec - fromSec,
        views: 0,
        likes: 0,
        file: `${id}.mp4`,
        bytes: 1,
        files: {},
        status: "saved",
        recordedAt: "2026-01-01T00:00:00.000Z",
        source: {
            streamId,
            vodId: null,
            vodPageUrl: null,
            vodUrlAtClip: null,
            startAt: null,
            endAt: null,
            vodOffsetSec: fromSec,
            vodEndOffsetSec: toSec,
            offsetFrom: "site",
        },
    };
}

describe("findOverlaps", () => {
    it("pairs clips of one stream that overlap, and tells a duplicate from a clip inside a longer one", () => {
        const clips = [
            clip("a", 100, 130),
            clip("b", 101, 130),
            clip("c", 125, 160),
            clip("d", 200, 300),
            clip("f", 210, 240),
            clip("e", 100, 130, "s2"),
        ];
        const manifest: ClipsManifest = {
            version: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
            providers: {
                kick: { clips: Object.fromEntries(clips.map((entry) => [entry.id, entry])), vods: {}, vodParts: {} },
            },
        };
        const pairs = findOverlaps(manifest).map((overlap) => [
            overlap.a.id,
            overlap.b.id,
            overlap.overlapSec,
            overlap.duplicate ? "duplicate" : overlap.contained ? "contained" : "overlap",
        ]);

        expect(pairs).toEqual([
            ["a", "b", 29, "duplicate"],
            ["a", "c", 5, "overlap"],
            ["b", "c", 5, "overlap"],
            ["d", "f", 30, "contained"],
        ]);
        expect(findOverlaps(manifest).find((overlap) => overlap.contained)?.containedId).toBe("f");
    });

    it("keeps comparing clips with offsets when another clip of the stream has none", () => {
        const wallOnly = clip("w", 0, 0);
        wallOnly.source = {
            ...(wallOnly.source as ClipSource),
            vodOffsetSec: null,
            vodEndOffsetSec: null,
            startAt: "2026-01-01T00:00:00.000Z",
            endAt: "2026-01-01T00:00:30.000Z",
        };
        const timeless = clip("t", 0, 0);
        timeless.source = { ...(timeless.source as ClipSource), vodOffsetSec: null, vodEndOffsetSec: null };
        const clips = [clip("a", 100, 130), clip("b", 100, 130), wallOnly, timeless];
        const manifest: ClipsManifest = {
            version: 1,
            updatedAt: "",
            providers: {
                kick: { clips: Object.fromEntries(clips.map((entry) => [entry.id, entry])), vods: {}, vodParts: {} },
            },
        };

        expect(findOverlaps(manifest).map((overlap) => [overlap.a.id, overlap.b.id])).toEqual([["a", "b"]]);
    });
});

describe("chooseQuality", () => {
    const offered = [
        { name: "1080p60", height: 1080 },
        { name: "720p60", height: 720 },
        { name: "720p", height: 720 },
        { name: "360p", height: 360 },
    ];
    const pick = (quality?: string) =>
        chooseQuality({
            options: offered,
            quality,
            names: (option) => [option.name],
            height: (option) => option.height,
        }).name;

    it("takes the first option for best or no quality, and the last for worst", () => {
        expect(pick()).toBe("1080p60");
        expect(pick("BEST")).toBe("1080p60");
        expect(pick("worst")).toBe("360p");
    });

    it("matches an option's own name before a height, and a height to its best option", () => {
        expect(pick("720p")).toBe("720p");
        expect(pick("720")).toBe("720p60");
        expect(pick("720P60")).toBe("720p60");
    });

    it("names the offered qualities when none matches", () => {
        expect(() => pick("480p")).toThrow("Offered: best, worst, 1080p60, 720p60, 720p, 360p");
    });
});

describe("placeBySpan (Kick)", () => {
    const span = { startAt: "2026-11-19T05:38:33.068Z", endAt: "2026-11-19T05:39:06.402Z", durationSec: 33.334 };
    const vod: Vod = {
        provider: "kick",
        id: "a1c8e6f0-a768-4ef9-b7bb-c0de5c52d30e",
        streamId: "100",
        title: "stream",
        channel: "somechannel",
        startedAt: "2026-11-18T23:28:44.000Z",
        durationSec: 30000,
        live: false,
        access: "subscriber_only",
        pageUrl: null,
    };
    const playback = {
        variantUrl: "https://example.com/1080p60/playlist.m3u8",
        variantName: "1080p",
        bandwidth: 1,
        durationSec: 30000,
        startAt: "2026-11-18T23:28:39.600Z",
    };

    it("prefers the VOD playlist, then the start fitted from site offsets, then the stream start", () => {
        const fittedStartAt = "2026-11-18T23:28:39.500Z";
        const both = placeBySpan({ streamId: "100", span, fittedStartAt, vod, playback });
        expect([both.vodOffsetSec, both.offsetFrom]).toEqual([22193.468, "vod-playlist"]);

        const closed = placeBySpan({ streamId: "100", span, fittedStartAt, vod, playback: null });
        expect([closed.vodOffsetSec, closed.vodEndOffsetSec, closed.offsetFrom]).toEqual([
            22193.568,
            22226.902,
            "site",
        ]);

        const unplaced = placeBySpan({ streamId: "100", span, fittedStartAt: null, vod, playback: null });
        expect([unplaced.vodOffsetSec, unplaced.offsetFrom]).toEqual([22189.068, "stream-start"]);
    });

    it("fits the VOD start from whole-second offsets into the window every clip allows", () => {
        // True start 00:00:00.300: offsets 10.5 and 20.95 round down to 10 and 20.
        const fitted = fitVodStart([
            { startAt: "2026-11-19T00:00:10.800Z", siteOffsetSec: 10 },
            { startAt: "2026-11-19T00:00:21.250Z", siteOffsetSec: 20 },
        ]);
        // Window: after 00:00:00.250 (the second clip), up to 00:00:00.800 (the first).
        expect(fitted).toBe("2026-11-19T00:00:00.525Z");
        expect(fitVodStart([])).toBeNull();
    });

    it("fits a group larger than a call takes arguments", () => {
        const many = Array.from({ length: 200_000 }, (_, index) => ({
            startAt: new Date(Date.parse("2026-11-19T00:00:00.300Z") + index * 1000).toISOString(),
            siteOffsetSec: index,
        }));
        // Every clip allows the same window, 23:59:59.300 to 00:00:00.300; the fit is its middle.
        expect(fitVodStart(many)).toBe("2026-11-18T23:59:59.800Z");
    });

    it("takes only whole, positive offsets under a week from Kick", () => {
        expect([
            siteOffset(120),
            siteOffset(0),
            siteOffset(-5),
            siteOffset(1.5),
            siteOffset(1e12),
            siteOffset(null),
        ]).toEqual([120, null, null, null, null, null]);
    });
});

function kickClip(): Clip {
    return {
        provider: "kick",
        id: CLIP,
        title: "a clip",
        pageUrl: `https://kick.com/somechannel/clips/${CLIP}`,
        mediaUrl: "https://clips.kick.com/clip/playlist.m3u8",
        thumbnailUrl: null,
        durationSec: 33,
        views: 0,
        likes: 0,
        createdAt: "2026-11-19T05:39:48.000Z",
        channel: "somechannel",
        channelName: "SomeChannel",
        creator: null,
        category: null,
        mature: false,
        streamId: "100",
        vodOffsetSec: null,
    };
}

describe("recordClips", () => {
    it("keeps each file's own quality, so a skipped best file never takes a lower file's quality", () => {
        const manifest: ClipsManifest = { version: 1, updatedAt: "", providers: {} };
        const section = providerSection(manifest, "twitch");
        const twitchClip = { ...kickClip(), provider: "twitch" as const };
        const record = (output: string, quality: string | null, status: "saved" | "exists") =>
            recordClips({
                section,
                rows: [{ clip: twitchClip, output, status, bytes: 1, quality }],
                sources: new Map(),
                rebaseOnPlaylistStart: false,
            });

        record("/clips/a-720p-tw_x.mp4", "720p", "saved");
        record("/clips/a-tw_x.mp4", null, "exists");

        const saved = section.clips[CLIP];
        expect([saved.file, saved.quality]).toEqual(["a-tw_x.mp4", null]);
        expect(Object.keys(saved.files).sort()).toEqual(["a-720p-tw_x.mp4", "a-tw_x.mp4"]);
        expect(saved.files["a-720p-tw_x.mp4"]?.quality).toBe("720p");
    });

    it("places a clip from a VOD playlist start recorded before, once the playlist is closed", () => {
        const manifest: ClipsManifest = { version: 1, updatedAt: "", providers: {} };
        const section = providerSection(manifest, "kick");
        section.vods["100"] = {
            id: "vod-1",
            streamId: "100",
            title: "stream",
            channel: "somechannel",
            startedAt: "2026-11-18T23:28:44.000Z",
            durationSec: 30000,
            live: false,
            access: "subscriber_only",
            pageUrl: null,
            playlistStartAt: "2026-11-18T23:28:39.600Z",
            checkedAt: "",
        };
        const clip: Clip = {
            provider: "kick",
            id: "clip_1",
            title: "a clip",
            pageUrl: "https://kick.com/somechannel/clips/clip_1",
            mediaUrl: "https://example.com/clip_1/playlist.m3u8",
            thumbnailUrl: null,
            durationSec: 33,
            views: 0,
            likes: 0,
            createdAt: "2026-11-19T05:39:48.000Z",
            channel: "somechannel",
            channelName: "SomeChannel",
            creator: null,
            category: null,
            mature: false,
            streamId: "100",
            vodOffsetSec: 22193,
        };
        const site: ClipSource = {
            streamId: "100",
            vodId: "vod-1",
            vodPageUrl: null,
            vodUrlAtClip: null,
            startAt: "2026-11-19T05:38:33.068Z",
            endAt: "2026-11-19T05:39:06.402Z",
            vodOffsetSec: 22193,
            vodEndOffsetSec: 22226.334,
            offsetFrom: "site",
        };
        recordClips({
            section,
            rows: [{ clip, output: "/clips/a.mp4", status: "saved", bytes: 1, quality: "source" }],
            sources: new Map([["clip_1", site]]),
            rebaseOnPlaylistStart: true,
        });

        const source = section.clips.clip_1.source;
        expect([source?.vodOffsetSec, source?.vodEndOffsetSec, source?.offsetFrom]).toEqual([
            22193.468,
            22226.802,
            "vod-playlist",
        ]);

        // Twitch's stream time comes from its own offset: a recorded playlist start never moves it.
        recordClips({
            section,
            rows: [{ clip, output: "/clips/a.mp4", status: "saved", bytes: 1, quality: "source" }],
            sources: new Map([["clip_1", site]]),
            rebaseOnPlaylistStart: false,
        });
        expect(section.clips.clip_1.source?.vodOffsetSec).toBe(22193);
    });
});

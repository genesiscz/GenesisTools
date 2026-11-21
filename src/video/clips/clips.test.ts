import { describe, expect, it } from "bun:test";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { parseKickTarget } from "../kick/api";
import { fitVodStart, placeBySpan } from "../kick/provider";
import { parseTwitchTarget } from "../twitch/api";
import { type ClipsManifest, findOverlaps, type ManifestClip, providerSection, recordClips } from "./manifest";
import type { Clip, ClipSource, Vod } from "./types";

const CLIP = "clip_01M7RY9637GFHTX1SEQE9EWJ88";

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
});

describe("recordClips", () => {
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
        });

        const source = section.clips.clip_1.source;
        expect([source?.vodOffsetSec, source?.vodEndOffsetSec, source?.offsetFrom]).toEqual([
            22193.468,
            22226.802,
            "vod-playlist",
        ]);
    });
});

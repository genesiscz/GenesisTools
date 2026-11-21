import { describe, expect, it } from "bun:test";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { parseKickTarget } from "../kick/api";
import { parseTwitchTarget } from "../twitch/api";
import { type ClipsManifest, findOverlaps, type ManifestClip } from "./manifest";

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

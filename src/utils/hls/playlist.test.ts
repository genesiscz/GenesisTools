import { describe, expect, it } from "bun:test";
import { findHarPlaylists, harStreamCandidates } from "./har";
import { deriveSegmentTemplate, parsePlaylist, segmentUri } from "./playlist";

const BASE = "https://cdn.example.com/live/abc/";

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=4540800,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
stream_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=162800,RESOLUTION=256x144
stream_144p.m3u8
`;

const LIVE = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2849
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T10:00:00.000+0000
stream_720p_5550001112223_1_2849.ts
#EXTINF:2.000000,
stream_720p_5550001112223_1_2850.ts
#EXTINF:2.000000,
stream_720p_5550001112223_1_2851.ts
`;

describe("parsePlaylist", () => {
    it("reads a master playlist's variants with absolute URIs", () => {
        const playlist = parsePlaylist(MASTER, `${BASE}master.m3u8`);

        expect(playlist.kind).toBe("master");

        if (playlist.kind === "master") {
            expect(playlist.variants.map((v) => [v.height, v.bandwidth, v.uri])).toEqual([
                [1080, 4540800, `${BASE}stream_1080p.m3u8`],
                [144, 162800, `${BASE}stream_144p.m3u8`],
            ]);
        }
    });

    it("numbers a live media playlist's segments from the media sequence and sees no end", () => {
        const playlist = parsePlaylist(LIVE, `${BASE}stream_720p.m3u8`);

        expect(playlist.kind).toBe("media");

        if (playlist.kind === "media") {
            expect(playlist.segments.map((s) => s.sequence)).toEqual([2849, 2850, 2851]);
            expect(playlist.ended).toBe(false);
            expect(playlist.playlistType).toBeUndefined();
            expect(playlist.targetDurationSec).toBe(2);
        }
    });

    it("marks an ended playlist, an init segment and encryption", () => {
        const text = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
a.m4s
#EXT-X-ENDLIST
`;
        const playlist = parsePlaylist(text, `${BASE}v.m3u8`);

        expect(playlist.kind === "media" && playlist.ended).toBe(true);
        expect(playlist.kind === "media" && playlist.playlistType).toBeUndefined();
        expect(playlist.kind === "media" && playlist.initUri).toBe(`${BASE}init.mp4`);
        expect(playlist.kind === "media" && playlist.encryption).toBe("AES-128");
    });
});

describe("deriveSegmentTemplate", () => {
    it("cuts the run that equals the sequence, not an earlier number in the name", () => {
        const playlist = parsePlaylist(LIVE, `${BASE}stream_720p.m3u8`);
        const template = playlist.kind === "media" ? deriveSegmentTemplate(playlist.segments) : null;

        expect(template).not.toBeNull();

        if (template) {
            expect(segmentUri(template, 1922)).toBe(`${BASE}stream_720p_5550001112223_1_1922.ts`);
        }
    });

    it("keeps zero padding", () => {
        const segments = [
            { sequence: 42, uri: `${BASE}seg_00042.ts?token=x`, durationSec: 6 },
            { sequence: 43, uri: `${BASE}seg_00043.ts?token=x`, durationSec: 6 },
        ];
        const template = deriveSegmentTemplate(segments);

        expect(template && segmentUri(template, 7)).toBe(`${BASE}seg_00007.ts?token=x`);
    });

    it("returns null when segments are named by something else than the sequence", () => {
        const segments = [
            { sequence: 5, uri: `${BASE}a1b2.ts`, durationSec: 6 },
            { sequence: 6, uri: `${BASE}c3d4.ts`, durationSec: 6 },
        ];

        expect(deriveSegmentTemplate(segments)).toBeNull();
    });
});

describe("HAR playlists", () => {
    const har = {
        log: {
            pages: [{ id: "page_1", title: "https://example.com/watch/2" }],
            entries: [
                {
                    request: {
                        url: `${BASE}master.m3u8`,
                        headers: [
                            { name: "Referer", value: "https://example.com/" },
                            { name: "sec-ch-ua", value: "dropped" },
                        ],
                    },
                    response: { status: 200, content: { mimeType: "application/vnd.apple.mpegurl" } },
                },
                { request: { url: `${BASE}stream_720p.m3u8` }, response: { content: { text: LIVE } } },
                {
                    request: { url: "https://example.com/app.js" },
                    response: { content: { mimeType: "text/javascript" } },
                },
                {
                    pageref: "page_1",
                    request: { url: "https://vod.example.com/x/main.m3u8" },
                    response: { content: { text: MASTER } },
                },
            ],
        },
    };

    it("finds each playlist once, keeps only the replayable headers, and falls back to the only page", () => {
        const found = findHarPlaylists(har);

        expect(found.map((p) => [p.url, p.kind])).toEqual([
            [`${BASE}master.m3u8`, "unknown"],
            [`${BASE}stream_720p.m3u8`, "media"],
            ["https://vod.example.com/x/main.m3u8", "master"],
        ]);
        expect(found[0].headers).toEqual({ referer: "https://example.com/" });
        expect(found[0].page).toBe("https://example.com/watch/2");
    });

    it("offers one stream per folder, the first requested one when no master is known", () => {
        expect(harStreamCandidates(findHarPlaylists(har)).map((p) => p.url)).toEqual([
            `${BASE}master.m3u8`,
            "https://vod.example.com/x/main.m3u8",
        ]);
    });

    it("refuses a file that is not a HAR", () => {
        expect(() => findHarPlaylists({ nope: true })).toThrow("Not a HAR file");
    });
});

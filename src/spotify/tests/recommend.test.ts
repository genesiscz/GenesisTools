/**
 * Discover methods over hand-built histories: each method's positive case and the negative case
 * that keeps it honest (an old artist is not a burst, a well-explored artist is not unfinished).
 */
import { describe, expect, test } from "bun:test";
import { type CatalogArtist, emptyCatalog, mergeCatalog } from "@app/spotify/lib/catalog";
import { embedUrl, parseEmbedArtist } from "@app/spotify/lib/embed";
import type { Play } from "@app/spotify/lib/history";
import type { LibTrack } from "@app/spotify/lib/library";
import {
    buildArtistIndex,
    recommendBursts,
    recommendNeighbours,
    recommendOldLoves,
    recommendUnfinished,
    withCatalog,
} from "@app/spotify/lib/reports/recommend";
import { SafeJSON } from "@genesiscz/utils/json";

const DAY = 86_400_000;
const T0 = Date.parse("2025-01-01T12:00:00Z");

function play(artist: string, name: string, ts: number, extra: Partial<Play> = {}): Play {
    return {
        ts,
        ms: 180_000,
        uri: `spotify:track:${artist}-${name}`,
        name,
        artist,
        album: `${artist} album`,
        platform: "",
        country: "",
        reasonStart: "",
        reasonEnd: "",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito: false,
        ...extra,
    };
}

function liked(artist: string, name: string, at: number): LibTrack {
    return {
        uri: `spotify:track:${artist}-${name}`,
        name,
        playcount: null,
        addedAt: new Date(at).toISOString(),
        artists: [{ uri: `spotify:artist:${artist}`, name: artist }],
        album: { uri: `spotify:album:${artist}-${name}`, name: `${name} single` },
    };
}

const BURSTS = { windowDays: 14, minLikes: 2, newWithinDays: 30 };

describe("recommendBursts", () => {
    test("two likes within the window, right after the first play, make a burst", () => {
        const plays = [play("Fresh", "a", T0), play("Fresh", "b", T0 + DAY)];
        const library = [liked("Fresh", "a", T0 + DAY), liked("Fresh", "b", T0 + 3 * DAY)];
        const recs = recommendBursts(buildArtistIndex({ plays: plays, library: library, minMs: 30_000 }), BURSTS);

        expect(recs.map((r) => r.artist)).toEqual(["Fresh"]);
        expect(recs[0]?.evidence.map((e) => e.song)).toEqual(["a", "b"]);
        expect(recs[0]?.artistUri).toBe("spotify:artist:Fresh");
    });

    test("an artist you played long before the burst is not a discovery", () => {
        const plays = [play("Old", "a", T0 - 400 * DAY), play("Old", "b", T0)];
        const library = [liked("Old", "a", T0), liked("Old", "b", T0 + DAY)];

        expect(recommendBursts(buildArtistIndex({ plays: plays, library: library, minMs: 30_000 }), BURSTS)).toEqual(
            []
        );
    });

    test("the whole history decides newness, not the filtered window", () => {
        const old = play("Old", "a", T0 - 400 * DAY);
        const library = [liked("Old", "a", T0), liked("Old", "b", T0 + DAY)];
        const index = buildArtistIndex({ plays: [play("Old", "b", T0)], library, minMs: 30_000, history: [old] });

        expect(recommendBursts(index, BURSTS)).toEqual([]);
    });

    test("likes further apart than the window are not a burst", () => {
        const library = [liked("Slow", "a", T0), liked("Slow", "b", T0 + 40 * DAY)];

        expect(recommendBursts(buildArtistIndex({ plays: [], library: library, minMs: 30_000 }), BURSTS)).toEqual([]);
    });

    test("an artist you explored after the burst ranks below one you did not", () => {
        const library = [
            liked("Explored", "a", T0),
            liked("Explored", "b", T0 + DAY),
            liked("Untouched", "a", T0),
            liked("Untouched", "b", T0 + DAY),
        ];
        const later = Array.from({ length: 8 }, (_, i) => play("Explored", `deep cut ${i}`, T0 + (10 + i) * DAY));
        const recs = recommendBursts(buildArtistIndex({ plays: later, library: library, minMs: 30_000 }), BURSTS);

        expect(recs.map((r) => r.artist)).toEqual(["Untouched", "Explored"]);
    });
});

describe("recommendUnfinished", () => {
    const UNFINISHED = { minPlays: 20, maxSongs: 3 };

    test("many plays of few songs is unfinished; many songs is not; few plays is not", () => {
        const plays = [
            ...Array.from({ length: 30 }, (_, i) => play("Loop", i % 2 ? "one" : "two", T0 + i * DAY)),
            ...Array.from({ length: 30 }, (_, i) => play("Wide", `song ${i}`, T0 + i * DAY)),
            ...Array.from({ length: 5 }, (_, i) => play("Rare", "one", T0 + i * DAY)),
        ];
        const recs = recommendUnfinished(buildArtistIndex({ plays: plays, library: [], minMs: 30_000 }), UNFINISHED);

        expect(recs.map((r) => r.artist)).toEqual(["Loop"]);
        expect(recs[0]?.evidence[0]?.detail).toBe("15 plays");
    });

    test("a full play flagged as skipped counts once, not as a play and a skip", () => {
        const plays = Array.from({ length: 40 }, (_, i) =>
            play("Flagged", "one", T0 + i * DAY, { ms: 60_000, skipped: true })
        );
        const [rec] = recommendUnfinished(buildArtistIndex({ plays, library: [], minMs: 30_000 }), UNFINISHED);

        expect(rec?.reason).toContain("you skip them 100% of the time");
    });

    test("skips lower the score", () => {
        const plays = [
            ...Array.from({ length: 30 }, (_, i) => play("Kept", "one", T0 + i * DAY)),
            ...Array.from({ length: 30 }, (_, i) => play("Skipped", "one", T0 + i * DAY)),
            ...Array.from({ length: 30 }, (_, i) => play("Skipped", "one", T0 + i * DAY + 1000, { ms: 5000 })),
        ];
        const recs = recommendUnfinished(buildArtistIndex({ plays: plays, library: [], minMs: 30_000 }), UNFINISHED);

        expect(recs.map((r) => r.artist)).toEqual(["Kept", "Skipped"]);
    });
});

describe("recommendOldLoves", () => {
    test("a big artist that went quiet is an old love; one you still play is not", () => {
        const plays = [
            ...Array.from({ length: 60 }, (_, i) => play("Gone", `s${i % 6}`, T0 + i * DAY)),
            ...Array.from({ length: 60 }, (_, i) => play("Still", `s${i % 6}`, T0 + i * DAY)),
            play("Still", "s1", T0 + 500 * DAY),
        ];
        const recs = recommendOldLoves(buildArtistIndex({ plays: plays, library: [], minMs: 30_000 }), {
            minPlays: 50,
            quietMonths: 12,
        });

        expect(recs.map((r) => r.artist)).toEqual(["Gone"]);
        expect(recs[0]?.reason).toContain("You have not played them for");
    });
});

describe("recommendNeighbours", () => {
    test("an artist sharing sessions with a favourite, rarely played alone, is a neighbour", () => {
        const now = T0 + 200 * DAY;
        const plays: Play[] = [];
        for (let s = 0; s < 4; s++) {
            const start = now - (s + 1) * 400 * DAY;
            plays.push(play("Fav", "f", start), play("Next", "n", start + 200_000));
        }

        for (let i = 0; i < 20; i++) {
            plays.push(play("Fav", "f", now - i * DAY));
            plays.push(play("Busy", "b", now - i * DAY + 600_000));
        }

        const recs = recommendNeighbours(buildArtistIndex({ plays: plays, library: [], minMs: 30_000 }), {
            recentDays: 180,
            topArtists: 1,
            gapMinutes: 30,
            maxRecentPlays: 5,
        });

        expect(recs.map((r) => r.artist)).toEqual(["Next"]);
        expect(recs[0]?.evidence[0]).toEqual({ song: "Fav", detail: "together in 4 sessions" });
    });
});

describe("the artist catalogue", () => {
    const entry = (uri: string, names: string[]): Omit<CatalogArtist, "fetchedAt"> => ({
        uri,
        name: "Fresh",
        topTracks: names.map((name) => ({
            uri: `spotify:track:${name}`,
            name,
            playcount: 1000,
            albumUri: null,
            cover: null,
        })),
        popularReleases: [],
    });

    test("songs to try leave out what you played or liked, matched by title", () => {
        const plays = [play("Fresh", "Played One", T0)];
        const library = [liked("Fresh", "Liked One", T0), liked("Fresh", "Liked Two", T0 + DAY)];
        const index = buildArtistIndex({ plays: plays, library: library, minMs: 30_000 });
        const catalog = mergeCatalog(
            emptyCatalog(),
            [entry("spotify:artist:Fresh", ["played one", "Liked One", "New Song", "Another New"])],
            new Date(T0)
        );
        const [rec] = withCatalog(recommendBursts(index, BURSTS), index, catalog);

        expect(rec?.inCatalog).toBe(true);
        expect(rec?.songsToTry.map((s) => s.name)).toEqual(["New Song", "Another New"]);
    });

    test("a song heard outside the filtered window is not a song to try", () => {
        const library = [liked("Fresh", "a", T0), liked("Fresh", "b", T0 + DAY)];
        const history = [play("Fresh", "Old Hit", T0 - 2 * DAY), play("Fresh", "a", T0)];
        const index = buildArtistIndex({ plays: [play("Fresh", "a", T0)], library, minMs: 30_000, history });
        const catalog = mergeCatalog(
            emptyCatalog(),
            [entry("spotify:artist:Fresh", ["Old Hit", "Brand New"])],
            new Date(T0)
        );
        const [rec] = withCatalog(recommendBursts(index, BURSTS), index, catalog);

        expect(rec?.songsToTry.map((s) => s.name)).toEqual(["Brand New"]);
    });

    test("a pick without a catalogue entry stays as it was, marked not fetched", () => {
        const library = [liked("Fresh", "a", T0), liked("Fresh", "b", T0 + DAY)];
        const index = buildArtistIndex({ plays: [], library: library, minMs: 30_000 });
        const [rec] = withCatalog(recommendBursts(index, BURSTS), index, emptyCatalog());

        expect(rec?.inCatalog).toBe(false);
        expect(rec?.songsToTry).toEqual([]);
    });

    test("a merge replaces the artists it fetched and keeps the others", () => {
        const first = mergeCatalog(
            emptyCatalog(),
            [entry("spotify:artist:A", ["x"]), entry("spotify:artist:B", ["y"])],
            new Date(T0)
        );
        const second = mergeCatalog(first, [entry("spotify:artist:A", ["z"])], new Date(T0 + DAY));

        expect(Object.keys(second.artists).sort()).toEqual(["spotify:artist:A", "spotify:artist:B"]);
        expect(second.artists["spotify:artist:A"]?.topTracks.map((t) => t.name)).toEqual(["z"]);
        expect(second.artists["spotify:artist:B"]?.fetchedAt).toBe(new Date(T0).toISOString());
    });
});

describe("the public embed page", () => {
    const page = (data: unknown) =>
        `<html><body><script id="__NEXT_DATA__" type="application/json">${SafeJSON.stringify(data, { strict: true })}</script></body></html>`;

    test("reads an artist's top tracks in order, with no play counts", () => {
        const html = page({
            props: {
                pageProps: {
                    state: {
                        data: {
                            entity: {
                                name: "Fresh",
                                uri: "spotify:artist:Fresh",
                                trackList: [
                                    { uri: "spotify:track:1", title: "First" },
                                    { uri: "spotify:track:2", title: "Second" },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const artist = parseEmbedArtist(html);

        expect(artist?.source).toBe("embed");
        expect(artist?.topTracks.map((t) => [t.name, t.playcount])).toEqual([
            ["First", null],
            ["Second", null],
        ]);
        expect(embedUrl("spotify:artist:Fresh")).toBe("https://open.spotify.com/embed/artist/Fresh");
    });

    test("a page without the artist data is not an artist", () => {
        expect(parseEmbedArtist("<html>blocked</html>")).toBeNull();
        expect(parseEmbedArtist(page({ props: { pageProps: {} } }))).toBeNull();
    });

    test("an embed entry never replaces a web-player entry", () => {
        const web = mergeCatalog(
            emptyCatalog(),
            [
                {
                    uri: "spotify:artist:A",
                    name: "A",
                    source: "web-player",
                    topTracks: [],
                    popularReleases: [{ uri: "r", name: "LP", type: "ALBUM", year: 2024, tracks: 10, cover: null }],
                },
            ],
            new Date(T0)
        );
        const after = mergeCatalog(
            web,
            [{ uri: "spotify:artist:A", name: "A", source: "embed", topTracks: [], popularReleases: [] }],
            new Date(T0 + DAY)
        );

        expect(after.artists["spotify:artist:A"]?.popularReleases).toHaveLength(1);
        expect(after.artists["spotify:artist:A"]?.source).toBe("web-player");
    });
});

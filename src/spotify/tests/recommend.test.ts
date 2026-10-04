/**
 * Discover methods over hand-built histories: each method's positive case and the negative case
 * that keeps it honest (an old artist is not a burst, a well-explored artist is not unfinished).
 */
import { describe, expect, test } from "bun:test";
import type { Play } from "@app/spotify/lib/history";
import type { LibTrack } from "@app/spotify/lib/library";
import {
    buildArtistIndex,
    recommendBursts,
    recommendNeighbours,
    recommendOldLoves,
    recommendUnfinished,
} from "@app/spotify/lib/reports/recommend";

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
        const recs = recommendBursts(buildArtistIndex(plays, library, 30_000), BURSTS);

        expect(recs.map((r) => r.artist)).toEqual(["Fresh"]);
        expect(recs[0]?.evidence.map((e) => e.song)).toEqual(["a", "b"]);
        expect(recs[0]?.artistUri).toBe("spotify:artist:Fresh");
    });

    test("an artist you played long before the burst is not a discovery", () => {
        const plays = [play("Old", "a", T0 - 400 * DAY), play("Old", "b", T0)];
        const library = [liked("Old", "a", T0), liked("Old", "b", T0 + DAY)];

        expect(recommendBursts(buildArtistIndex(plays, library, 30_000), BURSTS)).toEqual([]);
    });

    test("likes further apart than the window are not a burst", () => {
        const library = [liked("Slow", "a", T0), liked("Slow", "b", T0 + 40 * DAY)];

        expect(recommendBursts(buildArtistIndex([], library, 30_000), BURSTS)).toEqual([]);
    });

    test("an artist you explored after the burst ranks below one you did not", () => {
        const library = [
            liked("Explored", "a", T0),
            liked("Explored", "b", T0 + DAY),
            liked("Untouched", "a", T0),
            liked("Untouched", "b", T0 + DAY),
        ];
        const later = Array.from({ length: 8 }, (_, i) => play("Explored", `deep cut ${i}`, T0 + (10 + i) * DAY));
        const recs = recommendBursts(buildArtistIndex(later, library, 30_000), BURSTS);

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
        const recs = recommendUnfinished(buildArtistIndex(plays, [], 30_000), UNFINISHED);

        expect(recs.map((r) => r.artist)).toEqual(["Loop"]);
        expect(recs[0]?.evidence[0]?.detail).toBe("15 plays");
    });

    test("skips lower the score", () => {
        const plays = [
            ...Array.from({ length: 30 }, (_, i) => play("Kept", "one", T0 + i * DAY)),
            ...Array.from({ length: 30 }, (_, i) => play("Skipped", "one", T0 + i * DAY)),
            ...Array.from({ length: 30 }, (_, i) => play("Skipped", "one", T0 + i * DAY + 1000, { ms: 5000 })),
        ];
        const recs = recommendUnfinished(buildArtistIndex(plays, [], 30_000), UNFINISHED);

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
        const recs = recommendOldLoves(buildArtistIndex(plays, [], 30_000), { minPlays: 50, quietMonths: 12 });

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

        const recs = recommendNeighbours(buildArtistIndex(plays, [], 30_000), {
            recentDays: 180,
            topArtists: 1,
            gapMinutes: 30,
            maxRecentPlays: 5,
        });

        expect(recs.map((r) => r.artist)).toEqual(["Next"]);
        expect(recs[0]?.evidence[0]).toEqual({ song: "Fav", detail: "together in 4 sessions" });
    });
});

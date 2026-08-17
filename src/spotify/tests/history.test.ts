/**
 * The two pure pieces of the history layer that a report fixture cannot pin: the per-timezone
 * offset cache, and the composite keys everything groups by.
 */
import { describe, expect, test } from "bun:test";
import { albumKey, localTime, songKey, songKeyOf } from "@app/spotify/lib/history";

const play = (name: string, artist: string, album = "") => ({
    ts: 0,
    ms: 0,
    uri: "",
    name,
    artist,
    album,
    platform: "",
    country: "",
    reasonStart: "",
    reasonEnd: "",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito: false,
});

describe("localTime", () => {
    // Summer, when Prague is UTC+2 and London is UTC+1.
    const ts = Date.parse("2025-07-15T12:00:00Z");

    // The cache used to key on `day * 64 + (tz.length % 64)`. These two names are both 13
    // characters, so whichever profile was read first decided the other one's wall clock.
    test("two same-length timezones do not share cached offsets", () => {
        const prague = localTime(ts, "Europe/Prague");
        const london = localTime(ts, "Europe/London");
        expect(prague.hour).toBe(14);
        expect(london.hour).toBe(13);
    });

    test("and the answer does not depend on which was asked first", () => {
        const londonFirst = localTime(ts, "Europe/London");
        const pragueSecond = localTime(ts, "Europe/Prague");
        expect(londonFirst.hour).toBe(13);
        expect(pragueSecond.hour).toBe(14);
    });

    test("a zone across the date line lands on another day", () => {
        expect(localTime(Date.parse("2025-07-15T23:00:00Z"), "Pacific/Auckland").date).toBe("2025-07-16");
    });

    // Europe/Prague went CET → CEST at 01:00 UTC on 2025-03-30. Caching one offset for the
    // whole UTC day put everything after the transition an hour out; near midnight that also
    // moved plays onto the wrong DATE, and therefore into the wrong day, week and streak.
    test("plays on a DST transition day get the offset that actually applied", () => {
        expect(localTime(Date.parse("2025-03-30T00:30:00Z"), "Europe/Prague").hour).toBe(1);
        expect(localTime(Date.parse("2025-03-30T01:30:00Z"), "Europe/Prague").hour).toBe(3);
        expect(localTime(Date.parse("2025-03-30T22:30:00Z"), "Europe/Prague").date).toBe("2025-03-31");
    });

    test("and the autumn transition too, in the other direction", () => {
        expect(localTime(Date.parse("2025-10-26T00:30:00Z"), "Europe/Prague").hour).toBe(2);
        expect(localTime(Date.parse("2025-10-26T01:30:00Z"), "Europe/Prague").hour).toBe(2);
        expect(localTime(Date.parse("2025-10-26T02:30:00Z"), "Europe/Prague").hour).toBe(3);
    });
});

describe("composite keys", () => {
    // A space separator is not injective: these two collided, silently merging two songs in
    // every ranking, trend, blend and compatibility set.
    test("a title ending in a word does not collide with an artist starting with it", () => {
        expect(songKey(play("a b", "c"))).not.toBe(songKey(play("a", "b c")));
        expect(albumKey(play("x", "b c", "a b"))).not.toBe(albumKey(play("x", "c", "a b b")));
    });

    test("the key ignores case, so one song is one key", () => {
        expect(songKey(play("Midnight Lanes", "Nocturne Drive"))).toBe(
            songKey(play("midnight lanes", "NOCTURNE drive"))
        );
    });

    // The audit matches harvested library rows against played songs, and built its own key
    // until this was exported. That is what made "never played" jump from 74 to 149.
    test("songKeyOf agrees with songKey for the same title and artist", () => {
        expect(songKeyOf("Midnight Lanes", "Nocturne Drive")).toBe(songKey(play("Midnight Lanes", "Nocturne Drive")));
    });
});

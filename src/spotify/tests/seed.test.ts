/**
 * What each `--from` source promises, checked against synthetic history where the answer is
 * known by construction.
 *
 * The bug this exists for: `unplayed` filtered against plays that had cleared the 30-second
 * bar, so a liked track started twenty times and skipped at five seconds was offered as
 * "never played". A real run seeded 40 such tracks and 33 of them had been played. Nothing
 * in the type system or the CLI's output showed it — only asking the history did.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "@app/spotify/lib/context";
import { PLAY_MS, type Play } from "@app/spotify/lib/history";
import { seedTracks } from "@app/spotify/lib/play/seed";
import { SafeJSON } from "@genesiscz/utils/json";

const play = (uri: string, name: string, ms: number, ts = Date.now()): Play => ({
    ts,
    ms,
    uri,
    name,
    artist: "Artist",
    album: "Album",
    platform: "mac",
    country: "CZ",
    reasonStart: "clickrow",
    reasonEnd: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito: false,
});

/** A context standing in for a profile with a library, without touching disk. */
function ctxWith(plays: Play[]): Ctx {
    return {
        profile: { name: "t", label: "t", timezone: "Europe/Prague", addedAt: "2026-01-01T00:00:00.000Z" },
        tz: "Europe/Prague",
        all: plays,
        plays,
        genres: { byUri: new Map(), forPlay: () => [] } as unknown as Ctx["genres"],
        window: "all time",
        top: 20,
        json: false,
    };
}

describe("seed --from top", () => {
    test("ranks by plays that cleared the bar", () => {
        const plays = [
            play("spotify:track:a", "A", 60_000),
            play("spotify:track:a", "A", 60_000),
            play("spotify:track:b", "B", 60_000),
        ];
        const seeded = seedTracks({ source: "top", limit: 2, options: {}, given: ctxWith(plays) });

        expect(seeded.map((t) => t.name)).toEqual(["A", "B"]);
    });

    test("respects the limit", () => {
        const plays = ["a", "b", "c"].map((u) => play(`spotify:track:${u}`, u.toUpperCase(), 60_000));
        expect(seedTracks({ source: "top", limit: 2, options: {}, given: ctxWith(plays) })).toHaveLength(2);
    });
});

describe("seed --from forgotten", () => {
    test("excludes anything played inside the quiet window", () => {
        const old = Date.now() - 400 * 86_400_000;
        const plays = [play("spotify:track:old", "Old", 60_000, old), play("spotify:track:new", "New", 60_000)];
        const seeded = seedTracks({
            source: "forgotten",
            limit: 10,
            options: {},
            given: ctxWith(plays),
            quietMonths: 12,
        });

        expect(seeded.map((t) => t.name)).toEqual(["Old"]);
    });
});

describe("seed rejects an unknown source", () => {
    test("names the sources it accepts", () => {
        expect(() =>
            seedTracks({
                source: "nonsense" as never,
                limit: 1,
                options: {},
                given: ctxWith([play("spotify:track:a", "A", 60_000)]),
            })
        ).toThrow();
    });
});

describe("the 30-second bar and 'never played'", () => {
    /** Two liked tracks: one started repeatedly and always abandoned, one never touched. */
    function libraryWithSkippedAndUntouched(): Ctx {
        const dir = mkdtempSync(join(tmpdir(), "spotify-seed-unplayed-"));
        writeFileSync(
            join(dir, "spotify_library.jsonl"),
            [
                SafeJSON.stringify({
                    uri: "spotify:track:skipped",
                    name: "Skipped",
                    addedAt: "2026-01-01T00:00:00Z",
                    artists: [{ uri: "spotify:artist:a", name: "A" }],
                }),
                SafeJSON.stringify({
                    uri: "spotify:track:untouched",
                    name: "Untouched",
                    addedAt: "2026-01-02T00:00:00Z",
                    artists: [{ uri: "spotify:artist:b", name: "B" }],
                }),
            ].join("\n")
        );

        const ctx = ctxWith(Array.from({ length: 20 }, () => play("spotify:track:skipped", "Skipped", PLAY_MS - 1)));
        ctx.profile = { ...ctx.profile, dataDir: dir };

        return ctx;
    }

    // This is the regression itself, and it must go through `unplayed` rather than around it.
    // The previous version of this test asserted that `top` returned nothing and that the
    // fixture contained the play it had just been handed, so it passed with `unplayed` reading
    // either play set: a mutation swapping the correct set back for the buggy one killed no
    // assertion. Only calling the branch can catch that.
    test("a track only ever skipped early is not offered as never played", () => {
        const ctx = libraryWithSkippedAndUntouched();
        const seeded = seedTracks({ source: "unplayed", limit: 10, options: {}, given: ctx });

        expect(seeded.map((t) => t.uri)).toEqual(["spotify:track:untouched"]);
        rmSync(ctx.profile.dataDir!, { recursive: true, force: true });
    });

    // The other half: the bar still governs ranking, so a track that never clears it ranks
    // nowhere. Without this, "count every start" could be applied everywhere and still pass.
    test("the same track still ranks nowhere under top, which does use the bar", () => {
        const ctx = libraryWithSkippedAndUntouched();

        expect(seedTracks({ source: "top", limit: 10, options: {}, given: ctx })).toHaveLength(0);
        rmSync(ctx.profile.dataDir!, { recursive: true, force: true });
    });
});

describe("local files", () => {
    // A real library held exactly one: `spotify:local:::Rihanna+-+Pon+De+Replay...`, saved
    // from disk. It has no playcount and no artists, and the web player cannot start it by
    // URI, so seeding it yields a plan entry that fails at playback for no actionable reason.
    test("a spotify:local: uri is not seeded from the library", () => {
        const dir = mkdtempSync(join(tmpdir(), "spotify-seed-lib-"));
        writeFileSync(
            join(dir, "spotify_library.jsonl"),
            [
                SafeJSON.stringify({
                    uri: "spotify:local:::Some+File:257",
                    name: "Local File",
                    addedAt: "2026-01-02T00:00:00Z",
                    artists: [],
                }),
                SafeJSON.stringify({
                    uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
                    name: "Normal",
                    addedAt: "2026-01-01T00:00:00Z",
                    artists: [{ uri: "spotify:artist:a", name: "A" }],
                }),
            ].join("\n")
        );

        const ctx = ctxWith([]);
        ctx.profile = { ...ctx.profile, dataDir: dir };

        // `recent` sorts by addedAt, so the local file would come FIRST if it were included.
        const seeded = seedTracks({ source: "recent", limit: 10, options: {}, given: ctx });

        expect(seeded.map((t) => t.uri)).toEqual(["spotify:track:aaaaaaaaaaaaaaaaaaaaaa"]);
        rmSync(dir, { recursive: true, force: true });
    });
});

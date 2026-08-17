/**
 * End-to-end check of the CLI against synthetic data.
 *
 * Builds two throwaway profiles in a temp directory, points the tool's config, cache and
 * storage root at it, and runs every command. Nothing here touches the real profiles, the
 * real cache, or `~/.genesis-tools`.
 *
 * The fixtures double as the format documentation: the streaming-history shape Spotify
 * exports, and the three files the harvest and enrichment produce.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env as envUtil } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const CLI = resolve(dirname(import.meta.dir), "index.ts");

const root = mkdtempSync(join(tmpdir(), "spotify-cli-test-"));
// Through the shared accessor rather than reading `process.env` here: these commands run as
// child processes, so the overrides have to be handed over as an environment rather than set
// in this one, and `snapshot()` is the supported way to get the base to build on.
const env = {
    ...envUtil.testing.snapshot(),
    GENESIS_TOOLS_HOME: root,
    SPOTIFY_CONFIG_PATH: join(root, "profiles.json"),
    SPOTIFY_CACHE_DIR: join(root, "cache"),
    NO_COLOR: "1",
};

interface Ev {
    ts: string;
    platform: string;
    ms_played: number;
    conn_country: string;
    master_metadata_track_name: string;
    master_metadata_album_artist_name: string;
    master_metadata_album_album_name: string;
    spotify_track_uri: string;
    reason_start: string;
    reason_end: string;
    shuffle: boolean;
    skipped: boolean;
    offline: boolean;
    incognito_mode: boolean;
}

/** Deterministic so a failure is reproducible; Math.random would make this flaky. */
function lcg(seed: number): () => number {
    let s = seed >>> 0;

    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;

        return s / 4294967296;
    };
}

const CATALOGUE = [
    { artist: "Nocturne Drive", track: "Midnight Lanes", album: "Lanes", genre: "drum and bass" },
    { artist: "Nocturne Drive", track: "Second Wind", album: "Lanes", genre: "drum and bass" },
    { artist: "Halcyon Fields", track: "Paper Boats", album: "Fields", genre: "liquid drum and bass" },
    { artist: "Static Bloom", track: "Cold Static", album: "Bloom", genre: "dubstep" },
    { artist: "Static Bloom", track: "Warm Static", album: "Bloom", genre: "dubstep" },
    { artist: "Marigold Hour", track: "Sunday Light", album: "Hour", genre: "indie pop" },
    { artist: "Marigold Hour", track: "Kitchen Radio", album: "Hour", genre: "indie pop" },
    { artist: "Velvet Ledger", track: "Ledger Line", album: "Velvet", genre: "pop" },
    { artist: "Velvet Ledger", track: "Paper Trail", album: "Velvet", genre: "pop" },
    { artist: "Iron Meridian", track: "Due North", album: "Meridian", genre: "techno" },
];

const uriOf = (i: number) => `spotify:track:selftest${String(i).padStart(14, "0")}`;

async function makeHistory({
    dir,
    seed,
    weights,
    years,
}: {
    dir: string;
    seed: number;
    weights: number[];
    years: number[];
}): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const rand = lcg(seed);
    const total = weights.reduce((a, b) => a + b, 0);

    for (const year of years) {
        const rows: Ev[] = [];
        const count = 1200;
        for (let i = 0; i < count; i++) {
            let r = rand() * total;
            let idx = 0;
            while (idx < weights.length - 1 && r > weights[idx]!) {
                r -= weights[idx]!;
                idx++;
            }

            const item = CATALOGUE[idx]!;
            const dayOfYear = Math.floor(rand() * 364);
            const hour = Math.floor(rand() * 24);
            const ts = new Date(Date.UTC(year, 0, 1 + dayOfYear, hour, Math.floor(rand() * 60)))
                .toISOString()
                .replace(".000Z", "Z");
            const short = rand() < 0.15;
            rows.push({
                ts,
                platform: rand() < 0.5 ? "osx" : "ios",
                ms_played: short ? Math.floor(rand() * 25000) : 150000 + Math.floor(rand() * 120000),
                conn_country: "CZ",
                master_metadata_track_name: item.track,
                master_metadata_album_artist_name: item.artist,
                master_metadata_album_album_name: item.album,
                spotify_track_uri: uriOf(idx),
                reason_start: rand() < 0.8 ? "trackdone" : "clickrow",
                reason_end: short ? "fwdbtn" : "trackdone",
                shuffle: rand() < 0.4,
                skipped: short,
                offline: false,
                incognito_mode: false,
            });
        }

        rows.sort((a, b) => a.ts.localeCompare(b.ts));
        await Bun.write(join(dir, `Streaming_History_Audio_${year}.json`), SafeJSON.stringify(rows));
    }
}

async function makeLibrary(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });

    const artistUri = (name: string) =>
        `spotify:artist:${name.replace(/\W/g, "").toLowerCase().padEnd(22, "x").slice(0, 22)}`;

    const tracks = CATALOGUE.map((item, i) => ({
        uri: uriOf(i),
        name: item.track,
        playcount: 1000 * (i + 1) * (i % 3 === 0 ? 900 : 7),
        durationMs: 200000,
        explicit: "NONE",
        addedAt: `202${3 + (i % 3)}-0${1 + (i % 9)}-15T12:00:00Z`,
        artists: [{ uri: artistUri(item.artist), name: item.artist }],
        album: { uri: `spotify:album:${i}`, name: item.album, date: "2023-01-01T00:00:00Z" },
        genres: [item.genre],
    }));

    await Bun.write(
        join(dir, "spotify_library.jsonl"),
        `${tracks.map((t) => SafeJSON.stringify({ ...t, genres: undefined })).join("\n")}\n`
    );
    await Bun.write(
        join(dir, "spotify_library.genres.jsonl"),
        `${tracks.map((t) => SafeJSON.stringify(t)).join("\n")}\n`
    );

    const seen = new Set<string>();
    const mb: string[] = [];
    const lf: string[] = [];
    for (const item of CATALOGUE) {
        if (seen.has(item.artist)) {
            continue;
        }

        seen.add(item.artist);
        mb.push(
            SafeJSON.stringify({
                uri: artistUri(item.artist),
                name: item.artist,
                mb: {
                    mbid: "x",
                    mbName: item.artist,
                    score: 100,
                    exact: true,
                    type: "Group",
                    country: null,
                    tags: [{ name: item.genre, count: 3 }],
                },
            })
        );
        lf.push(
            SafeJSON.stringify({
                uri: artistUri(item.artist),
                name: item.artist,
                lf: { tags: [item.genre, "electronic"] },
            })
        );
    }

    await Bun.write(join(dir, "mb_artists.jsonl"), `${mb.join("\n")}\n`);
    await Bun.write(join(dir, "lf_artists.jsonl"), `${lf.join("\n")}\n`);
}

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    all: string;
}

async function run(args: string[]): Promise<RunResult> {
    const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr, all: stdout + stderr };
}

/** Asserts exit 0 first, so a crash reports the crash instead of a missing-needle diff. */
async function ok(args: string[]): Promise<RunResult> {
    const r = await run(args);
    if (r.exitCode !== 0) {
        throw new Error(
            `\`spotify ${args.join(" ")}\` exited ${r.exitCode}:\n${r.all.split("\n").slice(-12).join("\n")}`
        );
    }

    return r;
}

async function okJson<T>(args: string[]): Promise<T> {
    const r = await ok(args);

    // strict: the CLI must emit real JSON, so a body comment-json would happily accept is a bug.
    return SafeJSON.parse(r.stdout, { strict: true }) as T;
}

/** The text of a run, for the many assertions that only look at the output. */
async function okAll(args: string[]): Promise<string> {
    return (await ok(args)).all;
}

function expectContains(text: string, ...needles: string[]): void {
    for (const n of needles) {
        expect(text).toContain(n);
    }
}

beforeAll(async () => {
    // Two people: heavy overlap on the electronic half, divergence on the pop half.
    await makeHistory({
        dir: join(root, "a", "history"),
        seed: 42,
        weights: [30, 25, 20, 15, 12, 3, 2, 1, 1, 8],
        years: [2024, 2025, 2026],
    });
    await makeHistory({
        dir: join(root, "b", "history"),
        seed: 99,
        weights: [8, 6, 0, 4, 0, 30, 25, 20, 15, 2],
        years: [2024, 2025, 2026],
    });
    await makeLibrary(join(root, "a", "data"));

    await ok([
        "profile",
        "add",
        "a",
        "--history",
        join(root, "a", "history"),
        "--data",
        join(root, "a", "data"),
        "--label",
        "Alpha",
    ]);
    await ok(["profile", "add", "b", "--history", join(root, "b", "history"), "--label", "Beta"]);
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("profiles", () => {
    test("profile add reports the events it loaded", async () => {
        const r = await ok([
            "profile",
            "add",
            "a",
            "--history",
            join(root, "a", "history"),
            "--data",
            join(root, "a", "data"),
            "--label",
            "Alpha",
        ]);
        expectContains(r.all, "saved profile", "3,600");
    });

    test("profile list shows both people", async () => {
        expectContains(await okAll(["profile", "list"]), "Alpha", "Beta");
    });

    test("doctor names the missing harvest for the partner", async () => {
        expectContains(await okAll(["doctor"]), "Spotify Data Check", "Alpha", "Beta", "no harvested library");
    });

    test("an unknown profile is rejected", async () => {
        const r = await run(["analytics", "summary", "-p", "ghost"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("no profile");
    });

    // A commander default on `--tz` made every partial update pass a timezone, so
    // `profile add <existing> --label …` silently reset a configured zone to the default.
    test("a partial update keeps the configured timezone", async () => {
        await ok(["profile", "add", "tz", "--history", join(root, "b", "history"), "--tz", "America/New_York"]);
        await ok(["profile", "add", "tz", "--label", "Renamed"]);

        const v = await okJson<{ profile: { timezone: string; label: string } }>(["profile", "show", "tz", "--json"]);
        expect(v.profile.timezone).toBe("America/New_York");
        expect(v.profile.label).toBe("Renamed");
    });

    test("a new profile still gets the default timezone", async () => {
        await ok(["profile", "add", "tzdefault", "--history", join(root, "b", "history")]);

        const v = await okJson<{ profile: { timezone: string } }>(["profile", "show", "tzdefault", "--json"]);
        expect(v.profile.timezone).toBe("Europe/Prague");
    });
});

describe("summary", () => {
    test("prints the lifetime blocks", async () => {
        expectContains(
            await okAll(["analytics", "summary", "-p", "a"]),
            "listening summary",
            "by year",
            "longest streak",
            "diversity"
        );
    });

    test("json carries every year", async () => {
        const v = await okJson<{ totals: { plays: number }; years: unknown[] }>([
            "analytics",
            "summary",
            "-p",
            "a",
            "--json",
        ]);
        expect(v.totals.plays).toBeGreaterThan(2000);
        expect(v.years).toHaveLength(3);
    });

    // The standalone skill filtered on `--all-plays` when loading, then re-cut every report at
    // the 30s bar anyway, so the flag was a documented no-op outside `behavior`.
    test("--all-plays counts the short plays it promises to count", async () => {
        const strict = await okJson<{ totals: { plays: number; shortPlays: number } }>([
            "analytics",
            "summary",
            "-p",
            "a",
            "--json",
        ]);
        const all = await okJson<{ totals: { plays: number; shortPlays: number } }>([
            "analytics",
            "summary",
            "-p",
            "a",
            "--all-plays",
            "--json",
        ]);
        expect(strict.totals.shortPlays).toBeGreaterThan(0);
        expect(all.totals.plays).toBe(strict.totals.plays + strict.totals.shortPlays);
        expect(all.totals.shortPlays).toBe(0);
    });

    test("--min-ms raises the bar for what counts as a play", async () => {
        const strict = await okJson<{ totals: { plays: number } }>(["analytics", "summary", "-p", "a", "--json"]);
        const high = await okJson<{ totals: { plays: number } }>([
            "analytics",
            "summary",
            "-p",
            "a",
            "--min-ms",
            "200000",
            "--json",
        ]);
        expect(high.totals.plays).toBeLessThan(strict.totals.plays);
    });
});

describe("top", () => {
    test("artists ranks the heaviest first", async () => {
        expect(await okAll(["analytics", "top", "artists", "-p", "a"])).toContain("Nocturne Drive");
    });

    test("json rows are sorted by plays", async () => {
        const v = await okJson<{ rows: { name: string; plays: number }[] }>([
            "analytics",
            "top",
            "artists",
            "-p",
            "a",
            "--json",
        ]);
        const plays = v.rows.map((r) => r.plays);
        expect(plays).toEqual([...plays].sort((x, y) => y - x));
        expect(v.rows[0]!.name).toBe("Nocturne Drive");
    });

    test("genres report their coverage denominator", async () => {
        const v = await okJson<{ genres: { genre: string }[]; coverage: { taggedPlays: number } }>([
            "analytics",
            "top",
            "genres",
            "-p",
            "a",
            "--json",
        ]);
        expect(v.genres.map((g) => g.genre)).toContain("drum and bass");
        expect(v.coverage.taggedPlays).toBeGreaterThan(0);
    });

    test("songs folds releases", async () => {
        const v = await okJson<{ rows: unknown[] }>(["analytics", "top", "songs", "-p", "a", "--json"]);
        expect(v.rows.length).toBeGreaterThan(0);
    });

    // The standalone skill keyed `bySong` / `byAlbum` on `name\0artist` but built the trend
    // lookup with `name artist`, so these two columns were silently always empty. Every
    // aggregation now goes through one `songKey`, and this pins it.
    test.each(["songs", "albums", "tracks", "artists"])("%s rows carry a trend series", async (kind) => {
        const v = await okJson<{ rows: { trend?: number[] }[] }>(["analytics", "top", kind, "-p", "a", "--json"]);
        expect(v.rows[0]?.trend?.length).toBeGreaterThan(0);
    });

    test("albums renders", async () => {
        expect(await okAll(["analytics", "top", "albums", "-p", "a"])).toContain("album");
    });

    test("an unknown kind is rejected", async () => {
        const r = await run(["analytics", "top", "nonsense", "-p", "a"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("Pick one of");
    });

    test("--year does not leak into other years", async () => {
        const v = await okJson<{ rows: { plays: number }[] }>([
            "analytics",
            "top",
            "artists",
            "-p",
            "a",
            "--year",
            "2025",
            "--json",
        ]);
        expect(v.rows.reduce((s, r) => s + r.plays, 0)).toBeLessThanOrEqual(1200);
    });

    test("--artist does not leak other artists", async () => {
        const v = await okJson<{ rows: { artist: string }[] }>([
            "analytics",
            "top",
            "songs",
            "-p",
            "a",
            "--artist",
            "Static Bloom",
            "--json",
        ]);
        expect(v.rows.filter((r) => r.artist !== "Static Bloom")).toHaveLength(0);
    });

    test("--genre does not leak other genres", async () => {
        const v = await okJson<{ rows: { name: string }[] }>([
            "analytics",
            "top",
            "songs",
            "-p",
            "a",
            "--genre",
            "indie pop",
            "--json",
        ]);
        expect(v.rows.filter((r) => !["Sunday Light", "Kitchen Radio"].includes(r.name))).toHaveLength(0);
    });

    test("--csv writes the full ranking", async () => {
        const path = join(root, "top.csv");
        await ok(["analytics", "top", "artists", "-p", "a", "--csv", path]);
        expect(existsSync(path)).toBe(true);
    });
});

describe("time", () => {
    test("timeline buckets by year", async () => {
        const v = await okJson<{ points: unknown[] }>([
            "analytics",
            "timeline",
            "-p",
            "a",
            "--bucket",
            "year",
            "--json",
        ]);
        expect(v.points).toHaveLength(3);
    });

    test("clock grid and hour totals agree", async () => {
        const v = await okJson<{ byWeekdayHour: number[][]; byHour: number[] }>([
            "analytics",
            "clock",
            "-p",
            "a",
            "--json",
        ]);
        expect(v.byWeekdayHour).toHaveLength(7);
        expect(v.byWeekdayHour[0]).toHaveLength(24);
        const gridTotal = v.byWeekdayHour.flat().reduce((s, n) => s + n, 0);
        expect(v.byHour.reduce((s, n) => s + n, 0)).toBe(gridTotal);
    });

    test("calendar draws a year", async () => {
        expectContains(await okAll(["analytics", "calendar", "-p", "a", "--year", "2025"]), "2025", "Mon");
    });

    test("seasons names every season", async () => {
        expectContains(await okAll(["analytics", "seasons", "-p", "a"]), "seasonal rhythm", "winter", "summer");
    });
});

describe("behaviour", () => {
    test("behavior prints the device and reason breakdowns", async () => {
        expectContains(await okAll(["analytics", "behavior", "-p", "a"]), "shuffle", "devices", "how a track ends");
    });

    test("skips prints both tails", async () => {
        expectContains(
            await okAll(["analytics", "skips", "-p", "a", "--min", "5"]),
            "skip rate",
            "most skipped",
            "most finished"
        );
    });

    test("sessions prints the sittings", async () => {
        expectContains(await okAll(["analytics", "sessions", "-p", "a"]), "sittings", "longest sittings");
    });

    test("streaks prints runs and silences", async () => {
        expectContains(await okAll(["analytics", "streaks", "-p", "a"]), "longest runs", "longest silences");
    });
});

describe("biography", () => {
    test("the first year on record discovers artists", async () => {
        const v = await okJson<{ years: { newArtists: number }[] }>(["analytics", "discovery", "-p", "a", "--json"]);
        expect(v.years[0]!.newArtists).toBeGreaterThan(0);
    });

    test("firsts renders", async () => {
        expect(await okAll(["analytics", "firsts", "-p", "a", "--min", "10"])).toContain("first encounters");
    });

    test("forgotten renders", async () => {
        expect(await okAll(["analytics", "forgotten", "-p", "a", "--min", "5", "--quiet-months", "1"])).toContain(
            "forgotten favourites"
        );
    });

    test("an obsession peak never exceeds the song's total", async () => {
        const v = await okJson<{ hardest: { track: string; peakPlays: number; totalPlays: number }[] }>([
            "analytics",
            "obsessions",
            "-p",
            "a",
            "--json",
        ]);
        expect(v.hardest.filter((h) => h.peakPlays > h.totalPlays)).toHaveLength(0);
    });

    test("loyalty consistency stays within 0..1", async () => {
        const v = await okJson<{ artists: { artist: string; consistency: number }[] }>([
            "analytics",
            "loyalty",
            "-p",
            "a",
            "--min",
            "10",
            "--json",
        ]);
        expect(v.artists.filter((a) => a.consistency > 1.001)).toHaveLength(0);
    });
});

describe("library", () => {
    test("audit renders", async () => {
        expectContains(await okAll(["analytics", "audit", "-p", "a"]), "library audit", "played hard, never saved");
    });

    test("gems renders", async () => {
        expect(await okAll(["analytics", "gems", "-p", "a", "--min", "2", "--max-global", "999999999"])).toContain(
            "hidden gems"
        );
    });

    test("mainstream renders", async () => {
        expectContains(
            await okAll(["analytics", "mainstream", "-p", "a", "--min", "5"]),
            "mainstream check",
            "median track"
        );
    });

    test("saves renders", async () => {
        expect(await okAll(["analytics", "saves", "-p", "a"])).toContain("library growth");
    });
});

describe("deep dives", () => {
    test("artist", async () => {
        expectContains(
            await okAll(["analytics", "artist", "Nocturne", "-p", "a"]),
            "Nocturne Drive",
            "top tracks",
            "peak month"
        );
    });

    test("track", async () => {
        expectContains(await okAll(["analytics", "track", "Midnight Lanes", "-p", "a"]), "Midnight Lanes", "releases");
    });

    // Same root cause as the empty trend column: `track` re-derived the song key with a
    // different separator than `bySong`, so its peak window and arc saw zero plays and
    // printed "0 plays in the 30 days from 1970-01-01".
    test("track resolves its own plays for the peak window and the arc", async () => {
        const v = await okJson<{
            peakWindow: { plays: number; start: string } | null;
            arc: { fullValues: number[] } | null;
        }>(["analytics", "track", "Midnight Lanes", "-p", "a", "--json"]);
        expect(v.peakWindow?.plays).toBeGreaterThan(0);
        expect(v.peakWindow?.start.startsWith("1970")).toBe(false);
        expect(v.arc?.fullValues.some((n) => n > 0)).toBe(true);
    });

    test("search", async () => {
        expect(await okAll(["analytics", "search", "Static", "-p", "a"])).toContain("Cold Static");
    });

    test("wrapped", async () => {
        expectContains(
            await okAll(["analytics", "wrapped", "2025", "-p", "a"]),
            "2025 wrapped",
            "top songs",
            "top artists"
        );
    });
});

describe("dna and shift", () => {
    test("dna prints all eight axes", async () => {
        expectContains(
            await okAll(["analytics", "dna", "-p", "a"]),
            "taste DNA",
            "diversity",
            "obscurity",
            "repetition"
        );
    });

    test("every dna axis is a ratio", async () => {
        const v = await okJson<{ axes: { axis: string; value: number }[] }>(["analytics", "dna", "-p", "a", "--json"]);
        expect(v.axes).toHaveLength(8);
        expect(v.axes.filter((x) => x.value < 0 || x.value > 1)).toHaveLength(0);
    });

    test("shift renders", async () => {
        expectContains(
            await okAll(["analytics", "shift", "2024", "2026", "-p", "a"]),
            "taste shift",
            "what moved",
            "only in 2024"
        );
    });

    test("the same window is total continuity", async () => {
        const v = await okJson<{ continuity: number }>(["analytics", "shift", "2025", "2025", "-p", "a", "--json"]);
        expect(v.continuity).toBeGreaterThan(0.999);
    });

    test("continuity and change sum to 1", async () => {
        const v = await okJson<{ continuity: number; change: number }>([
            "analytics",
            "shift",
            "2024",
            "2026",
            "-p",
            "a",
            "--json",
        ]);
        expect(Math.abs(v.continuity + v.change - 1)).toBeLessThan(1e-6);
    });

    test("an empty window is rejected", async () => {
        const r = await run(["analytics", "shift", "2024", "2099", "-p", "a"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("no plays in 2099");
    });
});

describe("two people", () => {
    test("compat prints every block", async () => {
        expectContains(
            await okAll(["analytics", "compat", "a", "b"]),
            "compatibility",
            "what the score is made of",
            "common ground",
            "private territory"
        );
    });

    test("compat scores stay within 0..1 and report four components", async () => {
        const v = await okJson<{ compatibility: number; components: { name: string; score: number }[] }>([
            "analytics",
            "compat",
            "a",
            "b",
            "--json",
        ]);
        expect(v.compatibility).toBeGreaterThanOrEqual(0);
        expect(v.compatibility).toBeLessThanOrEqual(1);
        expect(v.components).toHaveLength(4);
        expect(v.components.filter((x) => x.score < 0 || x.score > 1)).toHaveLength(0);
    });

    test("compat is symmetric", async () => {
        const ab = await okJson<{ compatibility: number }>(["analytics", "compat", "a", "b", "--json"]);
        const ba = await okJson<{ compatibility: number }>(["analytics", "compat", "b", "a", "--json"]);
        expect(Math.abs(ab.compatibility - ba.compatibility)).toBeLessThan(1e-9);
    });

    test("compat with yourself is 1.0", async () => {
        const v = await okJson<{ compatibility: number }>(["analytics", "compat", "a", "a", "--json"]);
        expect(v.compatibility).toBeGreaterThan(0.999);
    });

    test("the profile without enrichment borrows genres from the one that has them", async () => {
        const v = await okJson<{ components: { name: string; score: number }[] }>([
            "analytics",
            "compat",
            "a",
            "b",
            "--json",
        ]);
        const genre = v.components.find((x) => x.name === "genre profile");
        expect(genre?.score).toBeGreaterThan(0);
    });

    test("the timeline scores every period that clears the floor", async () => {
        const v = await okJson<{ points: { compatibility: number | null }[] }>([
            "analytics",
            "compat",
            "a",
            "b",
            "--timeline",
            "--bucket",
            "year",
            "--min-plays",
            "10",
            "--json",
        ]);
        expect(v.points).toHaveLength(3);
        expect(v.points.filter((p) => p.compatibility === null)).toHaveLength(0);
    });

    test("blend renders", async () => {
        expectContains(await okAll(["analytics", "blend", "a", "b", "--min", "2"]), "blend", "match");
    });

    test("gift only suggests songs the other person never played", async () => {
        const v = await okJson<{ candidates: { track: string }[] }>(["analytics", "gift", "a", "b", "--json"]);
        expect(v.candidates.length).toBeGreaterThan(0);
        expect(v.candidates.map((x) => x.track).sort()).toEqual(["Paper Boats", "Warm Static"]);
    });
});

/**
 * The data-plane commands: the ones that WRITE derived files rather than print a report. They
 * run offline — the network crawls are `enrich`, which these deliberately do not touch — so the
 * merges can be pinned against the same fixtures every other test uses.
 */
describe("pipeline", () => {
    test("build indexes the artists in the harvested library", async () => {
        const v = await okJson<{ tracks: number; artists: number; jsonlPath: string }>(["build", "-p", "a", "--json"]);
        expect(v.tracks).toBe(CATALOGUE.length);
        // Six distinct artists across the ten-track catalogue.
        expect(v.artists).toBe(new Set(CATALOGUE.map((c) => c.artist)).size);
        expect(existsSync(join(root, "a", "data", "artists.json"))).toBe(true);
    });

    test("genres-merge writes the genre library and counts what it tagged", async () => {
        const v = await okJson<{
            library: { tracks: number; tagged: number };
            genres: { genre: string; tracks: number }[];
        }>(["genres-merge", "-p", "a", "--since", "2000-01-01", "--json"]);

        expect(v.library.tracks).toBe(CATALOGUE.length);
        expect(v.library.tagged).toBe(CATALOGUE.length);
        expect(v.genres.map((g) => g.genre)).toContain("drum and bass");
        expect(existsSync(join(root, "a", "data", "spotify_library.genres.jsonl"))).toBe(true);
    });

    // The join between the two halves of the tool: personal plays onto the harvested library.
    // Every count here is a place a refactor could silently drop or double plays.
    test("history-merge joins the export onto the library without losing plays", async () => {
        const v = await okJson<{
            files: number;
            events: number;
            eventsWithoutUri: number;
            distinctTracks: number;
            totalPlays: number;
            library: { total: number; matched: number };
            rows: { label: string; plays: number }[];
        }>(["history-merge", "-p", "a", "--json"]);

        expect(v.files).toBe(3);
        expect(v.events).toBe(3600);
        expect(v.eventsWithoutUri).toBe(0);
        expect(v.distinctTracks).toBe(CATALOGUE.length);
        expect(v.library.total).toBe(CATALOGUE.length);
        expect(v.library.matched).toBe(CATALOGUE.length);
        expect(existsSync(join(root, "a", "data", "spotify_library.full.jsonl"))).toBe(true);

        // Plays are the >=30s subset of the events, and the summary agrees with the rows.
        const summary = await okJson<{ totals: { plays: number } }>(["analytics", "summary", "-p", "a", "--json"]);
        expect(v.totalPlays).toBe(summary.totals.plays);
        expect(v.rows[0]!.plays).toBeGreaterThan(0);
    });

    test("history-merge groups by artist and by genre from the same data", async () => {
        const byArtist = await okJson<{ rows: { label: string; plays: number }[] }>([
            "history-merge",
            "-p",
            "a",
            "--by",
            "artists",
            "--json",
        ]);
        expect(byArtist.rows[0]!.label).toBe("Nocturne Drive");

        const byGenre = await okJson<{ rows: { label: string; extra?: number }[] }>([
            "history-merge",
            "-p",
            "a",
            "--by",
            "genres",
            "--json",
        ]);
        expect(byGenre.rows.map((r) => r.label)).toContain("drum and bass");
    });

    test("an unknown --by is rejected", async () => {
        const r = await run(["history-merge", "-p", "a", "--by", "planets"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("Pick one of");
    });
});

describe("export", () => {
    test("csv", async () => {
        const path = join(root, "out.csv");
        expect(await okAll(["export", "songs", "-p", "a", "--out", path])).toContain("wrote");
        expect(existsSync(path)).toBe(true);
    });

    test("jsonl", async () => {
        const path = join(root, "out.jsonl");
        await ok(["export", "library", "-p", "a", "--out", path]);
        expect(existsSync(path)).toBe(true);
    });

    test("artists", async () => {
        const path = join(root, "artists.csv");
        await ok(["export", "artists", "-p", "a", "--out", path]);
        expect(existsSync(path)).toBe(true);
    });

    // `--format jsno --out report.json` used to fall through to the CSV branch: CSV inside a
    // .json file, exit 0, and "jsno" echoed back as the format in the machine payload.
    test("an unknown --format is rejected instead of writing CSV", async () => {
        const path = join(root, "bad-format.json");
        const r = await run(["export", "songs", "-p", "a", "--out", path, "--format", "jsno"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("Pick one of");
        expect(existsSync(path)).toBe(false);
    });

    // `--top` was advertised by the shared analytics flags but read by nothing here, so
    // `--top 1` and `--top 100` printed byte-identical output. A flag that accepts a value and
    // ignores it is worse than one that does not exist: it reads as done.
    test("--top bounds the preview instead of being ignored", async () => {
        type Preview = { rows: unknown[]; limit: number; total: number };
        const one = await okJson<Preview>(["export", "songs", "-p", "a", "--top", "1", "--json"]);
        const three = await okJson<Preview>(["export", "songs", "-p", "a", "--top", "3", "--json"]);

        expect(one.rows).toHaveLength(1);
        expect(three.rows).toHaveLength(3);
        expect(one.limit).toBe(1);
        // The total must describe the whole ranking, not the slice, or a script reads a
        // truncated preview as the complete export.
        expect(one.total).toBe(three.total);
        expect(one.total).toBeGreaterThan(3);
    });

    // `--out` writes the ranking; bounding that by a preview flag would silently truncate a file
    // the user asked to be complete.
    test("--top does not truncate what --out writes", async () => {
        const capped = join(root, "capped.jsonl");
        const full = join(root, "full.jsonl");
        await ok(["export", "songs", "-p", "a", "--out", capped, "--top", "1"]);
        await ok(["export", "songs", "-p", "a", "--out", full]);

        expect(readFileSync(capped, "utf8")).toBe(readFileSync(full, "utf8"));
    });
});

describe("play thresholds in aggregations", () => {
    // `plays` and `shortPlays` split at the 30-second royalty threshold, which is a fixed
    // meaning: `--min-ms` chooses which events are counted at all, not what "a play" is called.
    // These pin that contract, since the two options interact and the wrong reading (shortPlays
    // relative to --min-ms) would make the column always zero.
    test("--all-plays adds the sub-30s events as shortPlays, not as plays", async () => {
        const strict = await okJson<{ rows: { plays: number; shortPlays: number }[] }>([
            "analytics",
            "top",
            "songs",
            "-p",
            "a",
            "--json",
        ]);
        const all = await okJson<{ rows: { plays: number; shortPlays: number }[] }>([
            "analytics",
            "top",
            "songs",
            "-p",
            "a",
            "--all-plays",
            "--json",
        ]);

        const sum = (rows: { plays: number; shortPlays: number }[], key: "plays" | "shortPlays") =>
            rows.reduce((s, r) => s + r[key], 0);

        expect(sum(strict.rows, "shortPlays")).toBe(0);
        expect(sum(all.rows, "shortPlays")).toBeGreaterThan(0);
        expect(sum(all.rows, "plays")).toBe(sum(strict.rows, "plays"));
    });

    test("a --min-ms above the threshold drops events from plays", async () => {
        const strict = await okJson<{ rows: { plays: number }[] }>(["analytics", "top", "songs", "-p", "a", "--json"]);
        const high = await okJson<{ rows: { plays: number }[] }>([
            "analytics",
            "top",
            "songs",
            "-p",
            "a",
            "--min-ms",
            "200000",
            "--json",
        ]);

        const sum = (rows: { plays: number }[]) => rows.reduce((s, r) => s + r.plays, 0);
        expect(sum(high.rows)).toBeLessThan(sum(strict.rows));
        expect(sum(high.rows)).toBeGreaterThan(0);
    });
});

describe("option validation", () => {
    // A NaN threshold makes every `>=` comparison false, so the report came back empty and said
    // nothing about why. Each of these must name the option instead.
    test("a non-numeric --min is rejected", async () => {
        const r = await run(["analytics", "top", "artists", "-p", "a", "--min", "abc"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("--min must be a number");
    });

    test("a non-numeric --top is rejected", async () => {
        const r = await run(["analytics", "top", "artists", "-p", "a", "--top", "many"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("--top must be a number");
    });

    test("an unknown --bucket is rejected", async () => {
        const r = await run(["analytics", "timeline", "-p", "a", "--bucket", "fortnight"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("fortnight");
    });

    // The window filter compares YYYY-MM-DD strings lexicographically, so a date that does not
    // exist used to select nothing (or everything) and report it as a real, empty result.
    test("a date that is not a date is rejected", async () => {
        for (const value of ["2025-13-01", "2025-02-30", "zzz", "2025-1-1"]) {
            const r = await run(["analytics", "summary", "-p", "a", "--since", value]);
            expect(r.exitCode).not.toBe(0);
            expect(r.all).toContain("--since must be a date");
        }
    });

    test("a malformed --year is rejected", async () => {
        const r = await run(["analytics", "summary", "-p", "a", "--year", "202x"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("--year must be a four-digit year");
    });

    test("a reversed window is rejected", async () => {
        const r = await run(["analytics", "summary", "-p", "a", "--since", "2026-01-01", "--until", "2024-01-01"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("is after");
    });

    test("the two-person reports validate the window the same way", async () => {
        const r = await run(["analytics", "compat", "a", "b", "--since", "2025-13-01"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("--since must be a date");
    });

    test("a real window still works", async () => {
        const v = await okJson<{ totals: { plays: number } }>([
            "analytics",
            "summary",
            "-p",
            "a",
            "--since",
            "2025-01-01",
            "--until",
            "2025-12-31",
            "--json",
        ]);
        expect(v.totals.plays).toBeGreaterThan(0);
    });
});

describe("play", () => {
    const tracksPath = join(root, "candidates.json");

    beforeAll(async () => {
        await Bun.write(
            tracksPath,
            SafeJSON.stringify([
                { uri: "spotify:track:aaa", name: "First", artists: "Nocturne Drive" },
                { uri: "spotify:track:bbb", name: "Second", windows: [[40, 30]] },
            ])
        );
    });

    test("plan starts from defaults and persists flag updates", async () => {
        const first = await okJson<{ windows: number[][]; queue: boolean; saved: boolean }>(["play", "plan", "--json"]);
        expect(first.saved).toBe(false);
        expect(first.windows).toEqual([
            [10, 3],
            [20, 3],
            [30, 3],
        ]);

        const updated = await okJson<{ windows: number[][]; tracks: string; saved: boolean }>([
            "play",
            "plan",
            "--windows",
            "5:2,50:4",
            "--tracks",
            tracksPath,
            "--json",
        ]);
        expect(updated.saved).toBe(true);
        expect(updated.windows).toEqual([
            [5, 2],
            [50, 4],
        ]);

        const reread = await okJson<{ windows: number[][]; tracks: string; queue: boolean }>([
            "play",
            "plan",
            "--json",
        ]);
        expect(reread.windows).toEqual([
            [5, 2],
            [50, 4],
        ]);
        expect(reread.tracks).toBe(tracksPath);
        expect(reread.queue).toBe(true);
    });

    test("a bad windows spec names the chunk and exits non-zero", async () => {
        const r = await run(["play", "plan", "--windows", "10:oops"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("10:oops");
    });

    test("status reads the plan's tracks file before any run", async () => {
        const v = await okJson<{ total: number; ok: number; remaining: number; nextIndex: number }>([
            "play",
            "status",
            "--json",
        ]);
        expect(v.total).toBe(2);
        expect(v.ok).toBe(0);
        expect(v.remaining).toBe(2);
        expect(v.nextIndex).toBe(0);
    });

    test("run refuses a missing tracks file before touching any browser", async () => {
        const r = await run(["play", "run", "--tracks", join(root, "nope.json")]);
        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("not found");
    });

    test("play harvest prints the library-download guide", async () => {
        expectContains(await okAll(["play", "harvest"]), "harvesting the library", "pathfinder");
    });
});

describe("commands that delete or mutate", () => {
    // cache-clear had no test at all, and it unlinks files. The guard that matters is which
    // files: it used to take every *.json in SPOTIFY_CACHE_DIR, and that variable is one
    // plausible mix-up away from a --data directory, where the same sweep removes
    // artists.json and costs an hour of re-crawling.
    test("cache-clear removes only files the cache itself wrote", async () => {
        const cache = join(root, "cache");
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "me-0123456789abcdef.json"), "{}");
        writeFileSync(join(cache, "demo-fedcba9876543210.json"), "{}");
        // The kind of thing that lives in a data directory:
        writeFileSync(join(cache, "artists.json"), '{"all":{}}');
        writeFileSync(join(cache, "spotify_library.jsonl"), "");

        const out = await okAll(["cache-clear"]);

        expect(existsSync(join(cache, "me-0123456789abcdef.json"))).toBe(false);
        expect(existsSync(join(cache, "demo-fedcba9876543210.json"))).toBe(false);
        expect(existsSync(join(cache, "artists.json"))).toBe(true);
        expect(existsSync(join(cache, "spotify_library.jsonl"))).toBe(true);
        expect(out).toContain("left 2 unrelated file(s) alone");
    });

    test("cache-clear on a missing directory says so instead of throwing", async () => {
        rmSync(join(root, "cache"), { recursive: true, force: true });
        expect(await okAll(["cache-clear"])).toContain("no cache directory");
    });

    test("profile use switches the default, and rm forgets it without touching files", async () => {
        const history = join(root, "b", "history");
        await ok(["profile", "add", "temp", "--history", history]);
        await ok(["profile", "use", "temp"]);

        const shown = await okJson<{ profile: { name: string } }>(["profile", "show", "--json"]);
        expect(shown.profile.name).toBe("temp");

        await ok(["profile", "use", "a"]);
        await ok(["profile", "rm", "temp"]);

        const gone = await run(["profile", "show", "temp"]);
        expect(gone.exitCode).not.toBe(0);
        // rm forgets a registration; the export it pointed at is the user's and stays put.
        expect(existsSync(history)).toBe(true);
    });

    // `ui.kv` pads the key to a 9-wide column with padEnd, which leaves NO separator once
    // the key IS 9 characters — "remaining" rendered as `remaining2 → resume at index 0`.
    test("play status separates every label from its value", async () => {
        const r = await ok(["play", "status"]);
        expect(r.all).toContain("play progress");
        expect(r.all).not.toMatch(/remaining\d/);
        expect(r.all).toMatch(/remaining\s+\d/);
    });
});

describe("enrich without an artist index", () => {
    // The raw failure was `ENOENT: no such file or directory, open '…/artists.json'`: a path
    // nobody recognises, naming a file they never heard of, with no hint that one command
    // creates it. Both crawls read that file, so the guard lives in the shared reader.
    test.each(["musicbrainz", "lastfm"])("%s names the command that builds it", async (source) => {
        const empty = join(root, "no-index");
        mkdirSync(empty, { recursive: true });
        await ok(["profile", "add", "noidx", "--history", join(root, "b", "history"), "--data", empty]);

        const r = await run(["enrich", source, "--profile", "noidx", "--limit", "1"]);

        expect(r.exitCode).not.toBe(0);
        expect(r.all).toContain("no artist index");
        expect(r.all).toContain("tools spotify build");
        expect(r.all).not.toContain("ENOENT");
    });
});

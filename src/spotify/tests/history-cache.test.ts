/**
 * The on-disk history cache: it must be keyed by the export's signature, survive a torn
 * write, and not accumulate a ~10 MB corpse per re-export.
 *
 * The leak was real before this: a live cache directory held two 10 MB files for one
 * profile, one of them permanently unreachable.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllPlays, profileCacheKey } from "@app/spotify/lib/history";
import type { Profile } from "@app/spotify/lib/profiles";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const root = mkdtempSync(join(tmpdir(), "spotify-histcache-test-"));
const historyDir = join(root, "history");
const cache = join(root, "cache");

const snapshot = env.testing.snapshot();

afterAll(() => {
    env.testing.restore(snapshot);
    rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
    name: "cachetest",
    label: "Cache Test",
    historyDir,
    timezone: "Europe/Prague",
    addedAt: "2026-01-01T00:00:00.000Z",
};

/** Rewrites the export with `n` plays; touching it changes the size/mtime signature. */
function writeExport(n: number): void {
    mkdirSync(historyDir, { recursive: true });
    const rows = Array.from({ length: n }, (_, i) => ({
        ts: `2025-01-0${(i % 9) + 1}T12:00:00Z`,
        ms_played: 60_000,
        spotify_track_uri: `spotify:track:t${i}`,
        master_metadata_track_name: `Song ${i}`,
        master_metadata_album_artist_name: "Artist",
        master_metadata_album_album_name: "Album",
        platform: "osx",
    }));
    const file = join(historyDir, "Streaming_History_Audio_2025_1.json");
    writeFileSync(file, SafeJSON.stringify(rows));
    // mtime has one-second granularity in the signature, so a same-second rewrite of the
    // same byte count would otherwise reuse the key and make this test lie.
    const future = new Date(Date.now() + 60_000 * (n + 1));
    utimesSync(file, future, future);
}

const cacheFiles = () => readdirSync(cache).filter((f) => f.startsWith(`${profileCacheKey("cachetest")}-`));

describe("history cache", () => {
    beforeEach(() => {
        rmSync(cache, { recursive: true, force: true });
        mkdirSync(cache, { recursive: true });
        env.testing.set("SPOTIFY_CACHE_DIR", cache);
    });

    test("writes one cache file for an export", () => {
        writeExport(3);
        expect(loadAllPlays(profile)).toHaveLength(3);
        expect(cacheFiles()).toHaveLength(1);
    });

    test("a re-export replaces the cache instead of adding to it", () => {
        writeExport(3);
        loadAllPlays(profile);
        const first = cacheFiles();

        writeExport(5);
        expect(loadAllPlays(profile)).toHaveLength(5);

        const after = cacheFiles();
        expect(after).toHaveLength(1);
        expect(after[0]).not.toBe(first[0]);
    });

    test("another profile's cache is never evicted", () => {
        writeExport(3);
        loadAllPlays(profile);
        writeFileSync(join(cache, "someoneelse-deadbeef.json"), "{}");

        writeExport(4);
        loadAllPlays(profile);

        expect(readdirSync(cache)).toContain("someoneelse-deadbeef.json");
    });

    test("a torn cache file is reparsed rather than fatal", () => {
        writeExport(3);
        loadAllPlays(profile);
        const [name] = cacheFiles();
        writeFileSync(join(cache, name!), '{"v":2,"sig":"x","dict":["a"],"rows":[[1,2');

        expect(loadAllPlays(profile)).toHaveLength(3);
    });
});

describe("profileCacheKey is injective", () => {
    // Sanitising alone collapses distinct VALID profile names onto one prefix: names only
    // have to avoid separators and "..", so `a b` and `a@b` both became `a_b`. The eviction
    // added earlier then deleted the other profile's cache — the exact invariant it promises
    // to keep. The earlier test could not catch this because it used an unrelated prefix.
    test.each([
        ["a b", "a@b"],
        ["me/x", "me:x"],
        ["Ann Marie", "Ann-Marie"],
    ])("%p and %p do not share a key", (left, right) => {
        expect(profileCacheKey(left)).not.toBe(profileCacheKey(right));
    });

    test("the same name always gives the same key", () => {
        expect(profileCacheKey("me")).toBe(profileCacheKey("me"));
    });

    test("the key stays readable and filesystem-safe", () => {
        const key = profileCacheKey("Ann Marie");
        expect(key).toMatch(/^[a-zA-Z0-9._-]+$/);
        expect(key).toContain("Ann_Marie");
    });

    // The names must genuinely collide under the OLD sanitiser, or this proves nothing:
    // "spaced x" and "spaced@x" both became "spaced_x", so evicting for one matched the
    // other's files by prefix. Verified: the old rule maps both to the same string.
    test("a sibling whose name sanitises identically keeps its cache", () => {
        const mine: Profile = { ...profile, name: "spaced x" };
        const siblingsFile = join(cache, `${profileCacheKey("spaced@x")}-0123456789abcdef.json`);

        expect("spaced x".replace(/[^a-zA-Z0-9._-]/g, "_")).toBe("spaced@x".replace(/[^a-zA-Z0-9._-]/g, "_"));

        writeExport(3);
        loadAllPlays(mine);
        writeFileSync(siblingsFile, "{}");

        // Same profile, changed export: this is the path that evicts.
        writeExport(4);
        loadAllPlays(mine);

        expect(existsSync(siblingsFile)).toBe(true);
    });
});

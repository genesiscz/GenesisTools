/**
 * The two tag rules the enrichment merge and the report-time resolver share. They used to be
 * copy-pasted into both, which is how a tag-cleaning change would have reached one path only;
 * these tests pin the rules themselves so the shared version cannot drift from what each
 * caller expects.
 */
import { describe, expect, test } from "bun:test";
import { LASTFM_TOP, lastfmTags, musicbrainzTags } from "@app/spotify/lib/genres";
import { type GenreResolver, mergeResolvers } from "@app/spotify/lib/library";

const tags = (...names: string[]) => names.map((name) => ({ name, count: 3 }));

describe("musicbrainzTags", () => {
    test("takes the tags of an exact, high-scoring match", () => {
        expect(musicbrainzTags({ uri: "a", mb: { exact: true, score: 100, tags: tags("techno", "dubstep") } })).toEqual(
            ["techno", "dubstep"]
        );
    });

    // MusicBrainz answers a name search with its best guesses, and a near-match is usually a
    // different band that shares a word.
    test("ignores a near match", () => {
        expect(musicbrainzTags({ uri: "a", mb: { exact: true, score: 70, tags: tags("techno") } })).toEqual([]);
        expect(musicbrainzTags({ uri: "a", mb: { exact: false, score: 100, tags: tags("techno") } })).toEqual([]);
    });

    test("ignores a tag nobody voted for, and one that is not a genre", () => {
        const row = {
            uri: "a",
            mb: { exact: true, score: 95, tags: [...tags("techno"), { name: "house", count: 0 }] },
        };
        expect(musicbrainzTags(row)).toEqual(["techno"]);
        expect(musicbrainzTags({ uri: "a", mb: { exact: true, score: 95, tags: tags("seen live") } })).toEqual([]);
    });

    test("handles a row with no MusicBrainz answer at all", () => {
        expect(musicbrainzTags({ uri: "a" })).toEqual([]);
        expect(musicbrainzTags({ uri: "a", mb: null })).toEqual([]);
    });
});

describe("mergeResolvers", () => {
    const resolverWith = (tags: Record<string, string[]>): GenreResolver => ({
        forPlay: (_uri, artist) => tags[artist.toLowerCase()] ?? [],
        forArtist: (artist) => tags[artist.toLowerCase()] ?? [],
        byUri: new Map(),
        byArtist: new Map(),
        vocabulary: new Set(),
        empty: false,
    });

    const play = (artist: string) =>
        ({ uri: "spotify:track:1", artist, name: "", album: "" }) as unknown as Parameters<
            ReturnType<typeof mergeResolvers>
        >[0];

    // `compat a b` and `compat b a` build the resolver list in opposite orders. With a
    // first-match rule the genre vector differed between them, so the score was not symmetric.
    test("gives the same genres whichever order the resolvers come in", () => {
        const a = resolverWith({ skeler: ["phonk", "trap"] });
        const b = resolverWith({ skeler: ["techno", "phonk"] });

        expect(mergeResolvers([a, b])(play("Skeler"))).toEqual(mergeResolvers([b, a])(play("Skeler")));
        expect(mergeResolvers([a, b])(play("Skeler"))).toEqual(["phonk", "techno", "trap"]);
    });

    test("a profile with no enrichment borrows from the one that has it", () => {
        const enriched = resolverWith({ skeler: ["phonk"] });
        const bare = resolverWith({});

        expect(mergeResolvers([bare, enriched])(play("Skeler"))).toEqual(["phonk"]);
        expect(mergeResolvers([bare, bare])(play("Skeler"))).toEqual([]);
    });
});

describe("lastfmTags", () => {
    test("keeps only tags the vocabulary already knows", () => {
        const vocabulary = new Set(["techno", "dubstep"]);
        expect(lastfmTags({ uri: "a", lf: { tags: ["techno", "australia", "dubstep"] } }, vocabulary)).toEqual([
            "techno",
            "dubstep",
        ]);
    });

    test("deduplicates and caps the list", () => {
        const vocabulary = new Set(["techno"]);
        expect(lastfmTags({ uri: "a", lf: { tags: ["techno", "techno"] } }, vocabulary)).toEqual(["techno"]);

        const many = Array.from({ length: LASTFM_TOP + 5 }, (_, i) => `genre ${i}`);
        expect(lastfmTags({ uri: "a", lf: { tags: many } }, new Set(many))).toHaveLength(LASTFM_TOP);
    });

    test("handles a row with no Last.fm answer at all", () => {
        expect(lastfmTags({ uri: "a" }, new Set(["techno"]))).toEqual([]);
    });
});

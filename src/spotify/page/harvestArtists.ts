/**
 * BROWSER PAYLOAD — run setupGql first, then call this with a list of `spotify:artist:…` URIs.
 * `harvest --artists --auto` runs it for you with the artists the Discover methods picked.
 *
 * One queryArtistOverview request per artist: the artist's most played songs, each with its
 * real global `playcount`, and its popular releases. That is what lets Discover say "songs by
 * this artist you have never played", which no local file knows.
 *
 * Pacing follows the measured rule in references/pathfinder-api.md (about 1 request per second
 * sustained): 3 requests in flight, then a 1 s pause.
 *
 * No type annotations: this text is evaluated as JavaScript inside the page.
 */
async (artistUris) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const HASH = "ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a";
    const CONCURRENCY = 3;
    const PAUSE_MS = 1000;

    // The smallest cover that is still sharp at 64 px, so the dashboard does not pull 640 px art.
    const cover = (sources) => {
        const list = (sources || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
        const pick = list.find((s) => (s.width || 0) >= 64) || list[0];

        return pick ? pick.url : null;
    };

    const one = async (uri, attempt = 0) => {
        const res = await window.__gql("queryArtistOverview", HASH, { uri, locale: "", includePrerelease: true });

        if (res.status !== 200) {
            if (attempt < 2) {
                await sleep(2000 * (attempt + 1));

                return one(uri, attempt + 1);
            }

            return { uri, error: `${res.status} ${String(res.json).slice(0, 120)}` };
        }

        const artist = res.json?.data?.artistUnion;
        if (!artist) {
            return { uri, error: "the response has no artistUnion" };
        }

        const discography = artist.discography || {};

        return {
            uri,
            name: artist.profile?.name ?? null,
            topTracks: (discography.topTracks?.items || [])
                .map((item) => item.track)
                .filter(Boolean)
                .map((t) => ({
                    uri: t.uri,
                    name: t.name,
                    playcount: t.playcount == null ? null : Number(t.playcount),
                    albumUri: t.albumOfTrack?.uri ?? null,
                    cover: cover(t.albumOfTrack?.coverArt?.sources),
                })),
            popularReleases: (discography.popularReleasesAlbums?.items || []).map((r) => ({
                uri: r.uri,
                name: r.name,
                type: r.type ?? null,
                year: r.date?.year ?? null,
                tracks: r.tracks?.totalCount ?? null,
                cover: cover(r.coverArt?.sources),
            })),
        };
    };

    const artists = [];
    const errors = [];
    for (let i = 0; i < artistUris.length; i += CONCURRENCY) {
        const results = await Promise.all(artistUris.slice(i, i + CONCURRENCY).map((uri) => one(uri)));
        for (const r of results) {
            if (r.error) {
                errors.push(r);
            } else {
                artists.push(r);
            }
        }

        if (i + CONCURRENCY < artistUris.length) {
            await sleep(PAUSE_MS);
        }
    }

    return { requested: artistUris.length, fetched: artists.length, errors, artists };
};

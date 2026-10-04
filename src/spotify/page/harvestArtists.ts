/**
 * BROWSER PAYLOAD — run setupGql first, then call this with a list of `spotify:artist:…` URIs and
 * the pacing settings. `harvest --artists --auto` runs it for you with the artists the Discover
 * methods picked and `ARTIST_PACING` from lib/browser/harvest.ts. The settings live there, not
 * here, because the same numbers decide how long the tool waits for this payload to finish.
 *
 * One queryArtistOverview request per artist: the artist's most played songs, each with its
 * real global `playcount`, and its popular releases. That is what lets Discover say "songs by
 * this artist you have never played", which no local file knows.
 *
 * Pacing follows the measured rule in references/pathfinder-api.md (about 1 request per second
 * sustained). One shared limiter spaces the STARTS of all requests, retries included, at least
 * `startIntervalMs` (1 s) apart. Up to `concurrency` (3) may be in flight, so a slow answer does
 * not lower the rate either.
 *
 * Every attempt has an `attemptMs` (15 s) deadline that covers the body too: the signal goes to
 * `__gql`, which hands it to `fetch`, and a timer race ends the attempt even if an older `__gql`
 * ignores it.
 *
 * One artist never sinks the harvest: a non-200 answer, a thrown request (network, JSON) and a
 * timeout are all tried `attempts` (3) times, `backoffMs` (2 s) longer before each retry, and then
 * come back as `{ uri, error }`, so the result still carries every artist read before and after it.
 *
 * No type annotations: this text is evaluated as JavaScript inside the page.
 */
async (artistUris, pacing) => {
    if (!pacing) {
        throw new Error("pass the pacing settings as the second argument (harvest --artists --auto does)");
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const HASH = "ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a";
    const { startIntervalMs, concurrency, attempts, attemptMs, backoffMs } = pacing;

    // The smallest cover that is still sharp at 64 px, so the dashboard does not pull 640 px art.
    const cover = (sources) => {
        const list = (sources || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
        const pick = list.find((s) => (s.width || 0) >= 64) || list[0];

        return pick ? pick.url : null;
    };

    // Each caller reserves the next free start slot, then waits for it. Every request and every
    // retry goes through here, so no path can start faster than one request a second.
    let nextStart = 0;
    const paced = async () => {
        const now = Date.now();
        const at = Math.max(now, nextStart);
        nextStart = at + startIntervalMs;

        if (at > now) {
            await sleep(at - now);
        }
    };

    const request = async (uri) => {
        await paced();

        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`no answer within ${attemptMs / 1000} s`);
                controller.abort(err);
                reject(err);
            }, attemptMs);
        });

        try {
            return await Promise.race([
                window.__gql(
                    "queryArtistOverview",
                    HASH,
                    { uri, locale: "", includePrerelease: true },
                    { signal: controller.signal }
                ),
                deadline,
            ]);
        } finally {
            clearTimeout(timer);
        }
    };

    const retry = async (uri, attempt, error) => {
        if (attempt < attempts - 1) {
            await sleep(backoffMs * (attempt + 1));

            return one(uri, attempt + 1);
        }

        return { uri, error };
    };

    const one = async (uri, attempt = 0) => {
        let res;
        try {
            res = await request(uri);
        } catch (err) {
            return retry(uri, attempt, `request failed: ${String(err?.message ?? err).slice(0, 120)}`);
        }

        if (res.status !== 200) {
            return retry(uri, attempt, `${res.status} ${String(res.json).slice(0, 120)}`);
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

    // `concurrency` workers take the next artist as soon as they are free. Results land in the
    // order the artists were given, whatever order they finished in.
    const results = new Array(artistUris.length);
    let next = 0;
    const worker = async () => {
        while (next < artistUris.length) {
            const i = next++;
            const uri = artistUris[i];
            // The catch covers what `one` does not retry: a response shaped so oddly that reading it throws.
            results[i] = await one(uri).catch((err) => ({ uri, error: String(err?.message ?? err).slice(0, 120) }));
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, artistUris.length) }, worker));

    const artists = results.filter((r) => !r.error);
    const errors = results.filter((r) => r.error);

    return { requested: artistUris.length, fetched: artists.length, errors, artists };
};

/**
 * BROWSER PAYLOAD — run setupGql first, then paste this into
 * mcp__chrome-devtools-mcp__evaluate_script WITH a filePath argument, because the result
 * is roughly 1 MB and would otherwise land in the conversation.
 *
 * Walks the Liked Songs pseudo-playlist through fetchPlaylistContents and returns every
 * track with its real global `playcount` — the number the public Web API does not expose
 * at all (it only has `popularity`, 0-100).
 *
 * Pacing: 4 requests in flight, then an 800 ms pause. That is roughly what one page load
 * of the app itself does, and it has completed 4200 tracks in ~90 s with zero errors.
 * Going faster has produced HTTP 503 Backend.max_conn from Varnish.
 *
 * No type annotations: this text is evaluated as JavaScript inside the page.
 *
 * Write the result into the profile's `--data` directory, next to the artist index and both
 * tag caches (`tools spotify profile show` prints the path). A previous harvest is kept
 * there, so a rerun is only needed for newly added tracks.
 */
async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const HASH = "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0";
    const URI = "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ";
    const LIMIT = 50;
    const CONCURRENCY = 4;
    const PAUSE_MS = 800;

    const page = async (offset, attempt = 0) => {
        const res = await window.__gql("fetchPlaylistContents", HASH, {
            uri: URI,
            offset,
            limit: LIMIT,
            enableWatchFeedEntrypoint: false,
        });

        if (res.status !== 200) {
            if (attempt < 3) {
                await sleep(2000 * (attempt + 1));

                return page(offset, attempt + 1);
            }

            return { offset, error: `${res.status} ${String(res.json).slice(0, 120)}` };
        }

        const content = res.json?.data?.playlistV2?.content;
        const items = (content?.items || [])
            .map((it) => {
                const d = it?.itemV2?.data;
                if (!d) {
                    return null;
                }

                return {
                    uri: d.uri,
                    name: d.name,
                    playcount: d.playcount == null ? null : Number(d.playcount),
                    durationMs: d.trackDuration?.totalMilliseconds ?? null,
                    explicit: d.contentRating?.label ?? null,
                    addedAt: it.addedAt?.isoString ?? null,
                    artists: (d.artists?.items || []).map((a) => ({ uri: a.uri, name: a.profile?.name })),
                    album: d.albumOfTrack
                        ? {
                              uri: d.albumOfTrack.uri,
                              name: d.albumOfTrack.name,
                              date: d.albumOfTrack.date?.isoString ?? null,
                          }
                        : null,
                };
            })
            .filter(Boolean);

        return { offset, total: content?.totalCount ?? null, items };
    };

    const first = await page(0);
    if (first.error) {
        return { fatal: first.error };
    }

    const offsets = [];
    for (let o = LIMIT; o < first.total; o += LIMIT) {
        offsets.push(o);
    }

    const all = [...first.items];
    const errors = [];
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
        const results = await Promise.all(offsets.slice(i, i + CONCURRENCY).map((o) => page(o)));
        for (const r of results) {
            if (r.error) {
                errors.push(r);
            } else {
                all.push(...r.items);
            }
        }
        await sleep(PAUSE_MS);
    }

    const seen = new Set();
    const tracks = [];
    for (const t of all) {
        if (!seen.has(t.uri)) {
            seen.add(t.uri);
            tracks.push(t);
        }
    }

    return {
        total: first.total,
        fetched: all.length,
        unique: tracks.length,
        requests: offsets.length + 1,
        errors,
        tracks,
    };
};

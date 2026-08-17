/**
 * BROWSER PAYLOAD — paste into mcp__chrome-devtools-mcp__evaluate_script on any
 * open.spotify.com tab. Needs no tokens.
 *
 * Recovers the whole persisted-query catalogue (operationName -> sha256Hash) from the
 * live JS bundle, so you never hardcode a hash that a web-player release has rotated.
 *
 * How it works: the bundle defines one tiny class whose constructor is
 * `(name, operation, sha256Hash, value)`, and every operation is a single
 * `new X("queryArtistOverview","query","<64 hex>",null)` literal. Matching that call
 * shape is far more robust than matching a hash next to a nearby string, which mostly
 * finds the generic words "query" and "mutation".
 *
 * Yielded 104 operations on the 2026-08-13 build. Pass a filePath if you want them all;
 * the inline return is deliberately trimmed to the ones worth knowing.
 *
 * No type annotations: this text is evaluated as JavaScript inside the page.
 */
async () => {
    const srcs = [...document.querySelectorAll("script[src]")]
        .map((s) => s.src)
        .filter((u) => u.includes("open.spotifycdn.com") || u.includes("/web-player/"));

    const ops = {};
    const failed = [];
    for (const u of srcs) {
        let txt;
        try {
            txt = await (await fetch(u)).text();
        } catch (err) {
            // A skipped bundle means a partial catalogue. Report it rather than returning a
            // short list that looks complete.
            failed.push({ url: u, error: String(err) });
            continue;
        }
        const re = /\.l\("([A-Za-z][A-Za-z0-9_]{2,60})","(query|mutation|subscription)","([0-9a-f]{64})"/g;
        let m;
        while ((m = re.exec(txt))) {
            ops[m[1]] = { op: m[2], hash: m[3] };
        }
    }

    const names = Object.keys(ops).sort();
    const interesting = [
        "fetchPlaylistContents",
        "fetchPlaylistMetadata",
        "fetchLibraryTracks",
        "libraryV3",
        "queryArtistOverview",
        "queryArtistDiscographyAll",
        "getAlbum",
        "searchDesktop",
        "decorateContextTracks",
        "getTrack",
    ];

    return {
        total: names.length,
        complete: failed.length === 0,
        failed,
        // If this is ever non-empty, Spotify put genre data back and the whole
        // MusicBrainz/Last.fm detour can be dropped.
        genreish: names.filter((n) => /genre|tag|mood|categor|taste|affinity/i.test(n)),
        known: Object.fromEntries(interesting.filter((n) => ops[n]).map((n) => [n, ops[n].hash])),
        ops,
    };
};

/**
 * BROWSER PAYLOAD — paste the function below into the DevTools Console of a tab that is
 * already on open.spotify.com, and call it. `harvest --auto` does this for you.
 *
 * Installs window.__gql, the one helper every other page payload calls. Replace
 * <BEARER> and <CLIENT_TOKEN> with the values read out of a live pathfinder request
 * (see references/pathfinder-api.md — do NOT try to mint them yourself, the /api/token
 * endpoint requires a rotating TOTP and returns 400 to anything else).
 *
 * Written without type annotations on purpose: the text is evaluated as JavaScript inside
 * the page, so anything TypeScript-only would be a syntax error there.
 */
async () => {
    window.__H = {
        authorization: "Bearer <BEARER>",
        "client-token": "<CLIENT_TOKEN>",
        "app-platform": "WebPlayer",
        "spotify-app-version": "1.2.97.200.gca3141fe-development",
        accept: "application/json",
        "content-type": "application/json;charset=UTF-8",
    };

    // `options.signal` is optional, so callers that pass three arguments work as before. An abort
    // also ends the body read below, which is what lets a caller put a deadline on a whole request.
    window.__gql = async (operationName, hash, variables, options) => {
        const r = await fetch("https://api-partner.spotify.com/pathfinder/v2/query", {
            method: "POST",
            headers: window.__H,
            signal: options?.signal,
            body: JSON.stringify({
                variables,
                operationName,
                extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
            }),
        });

        return { status: r.status, json: r.status === 200 ? await r.json() : await r.text() };
    };

    const probe = await window.__gql(
        "fetchPlaylistContents",
        "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0",
        { uri: "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ", offset: 0, limit: 1, enableWatchFeedEntrypoint: false }
    );

    return {
        installed: true,
        probeStatus: probe.status,
        totalLikedTracks: probe.json?.data?.playlistV2?.content?.totalCount ?? null,
        hint: probe.status === 401 ? "token expired — re-read it from a live request" : undefined,
    };
};

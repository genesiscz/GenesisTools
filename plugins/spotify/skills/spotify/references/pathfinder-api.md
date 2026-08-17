# Spotify's internal API (pathfinder GraphQL)

Everything here was measured against the live web player on 2026-08-13
(build `1.2.97.200.gca3141fe-development`). Where a claim comes from someone else it says so.

## Contents

- [The one endpoint](#the-one-endpoint)
- [Auth: how to get the two tokens](#auth-how-to-get-the-two-tokens)
- [Persisted queries and where the hashes live](#persisted-queries-and-where-the-hashes-live)
- [Operation catalogue](#operation-catalogue)
- [Useful response shapes](#useful-response-shapes)
- [Rate limits and failure modes](#rate-limits-and-failure-modes)
- [Prior art](#prior-art)

## The one endpoint

```
POST https://api-partner.spotify.com/pathfinder/v2/query
```

`/pathfinder/v1/query` still exists and some operations use it; v2 is what the current
player uses for everything interesting.

Required headers:

| Header | Value |
|---|---|
| `authorization` | `Bearer <web-player access token>` |
| `client-token` | device attestation token |
| `app-platform` | `WebPlayer` |
| `spotify-app-version` | e.g. `1.2.97.200.gca3141fe-development` |
| `content-type` | `application/json;charset=UTF-8` |

Body:

```json
{
  "variables": { "uri": "spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ", "offset": 0, "limit": 50 },
  "operationName": "fetchPlaylistContents",
  "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "86dde7b9…" } }
}
```

`spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ` is the **Liked Songs pseudo-playlist**. It
behaves like a normal playlist for `fetchPlaylistContents`, including `totalCount`.

Run the request **from inside an open.spotify.com page** (`evaluate_script`), not from
curl. Same-origin keeps CORS and the referer check happy, and it is the honest way to do
this — you are asking the app to do something it already does for itself.

## Auth: how to get the two tokens

Do **not** try to mint the access token. `GET open.spotify.com/api/token` now requires a
rotating TOTP (`?totp=…&totpServer=…&totpVer=61`) whose secret is obfuscated inside the JS
bundle and rotated deliberately to break scrapers. Calling it without a valid TOTP returns:

```
400 {"error":{"code":400,"message":"Unauthorized request",
     "extra":{"_notes":"Usage of this endpoint is not permitted under the Spotify Developer Terms…"}}}
```

The app calls it correctly on every page load, so **read the tokens back out of a request
it already made**:

1. `mcp__chrome-devtools-mcp__list_network_requests` with `resourceTypes: ["fetch"]`
2. Find any `api-partner.spotify.com/pathfinder/v2/query`
3. `mcp__chrome-devtools-mcp__get_network_request <reqid>` — the response prints the
   request headers, including `authorization` and `client-token`

Lifetimes: the access token carries `accessTokenExpirationTimestampMs`, about **55
minutes** out. On `401`, repeat the three steps — the app will have refreshed by itself.

Hooking `window.fetch` to sniff the headers does **not** work reliably; the app captured
its own reference before any hook you install after load.

> Treat both tokens, and the `sp_dc` / `sp_key` cookies, as passwords. They authorise the
> account, not just the page. Never write them to a file or paste them into a report.

## Persisted queries and where the hashes live

The client never sends GraphQL text, only `sha256Hash` of a query baked into the bundle.
A stale hash fails with a `PersistedQueryNotFound`-style error and there is no way to send
the text instead, so **hashes must be re-read after any web-player release**.

They are recoverable from the bundle in one pass. Module `589789` defines:

```js
class n { name; operation; sha256Hash; value; constructor(e,t,r,n){…} }
```

and every operation is one literal `new X("fetchPlaylistContents","query","<64 hex>",null)`.
So:

```js
/\.l\("([A-Za-z][A-Za-z0-9_]{2,60})","(query|mutation|subscription)","([0-9a-f]{64})"/g
```

over every `open.spotifycdn.com` script yields the full catalogue.
`src/spotify/page/extractOperations.ts` does exactly this.

Naive alternative — matching a 64-hex string near any quoted word — mostly returns the
words `query` and `mutation`. Match the constructor call, not proximity.

## Operation catalogue

104 operations on the 2026-08-13 build; the full dump is
`assets/pathfinder-operations-2026-08-13.json`. Re-extract rather than trusting these:

| operationName | sha256Hash |
|---|---|
| `fetchPlaylistContents` | `86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0` |
| `fetchPlaylistMetadata` | `86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0` |
| `fetchLibraryTracks` | `087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240` |
| `libraryV3` | `390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455` |
| `queryArtistOverview` | `ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a` |
| `queryArtistDiscographyAll` | `5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599` |
| `getAlbum` / `queryAlbumTracks` | `b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10` |
| `decorateContextTracks` | `383de00240775c39a6afe0b1055dc562b2a3930894201f9762f3fc32a74971c7` |

Several operations legitimately share a hash — one persisted document serves them all.

## Useful response shapes

`fetchPlaylistContents` → `data.playlistV2.content.{totalCount, items[]}`, each item:

```
addedAt.isoString
itemV2.data.{uri, name, playcount, trackDuration.totalMilliseconds, contentRating.label}
itemV2.data.artists.items[].{uri, profile.name}
itemV2.data.albumOfTrack.{uri, name, date.isoString}
```

**`playcount` is the real global stream count.** The public Web API has no equivalent —
it exposes only `popularity`, a 0-100 score. This is the single strongest reason to use
the internal API at all.

`queryArtistOverview` → `data.artistUnion.{id, uri, saved, profile, stats, discography,
relatedContent, visuals, goods}`. **No genre field.** See `references/genres.md`.

## Rate limits and failure modes

Spotify publishes no limit for this surface, and absence of a published limit is not
evidence that hammering is safe. Measured behaviour:

| What was done | What happened |
|---|---|
| 4 requests in flight, 800 ms pause between batches, 85 requests | 0 errors, ~90 s |
| page reloaded ~3×/second in a loop | `HTTP 503` Varnish `Backend.max_conn` |
| burst against `api.spotify.com` | `429` with `retry-after: 50` |
| web-player token used against `api.spotify.com` | `429` on the very first call |

Working rule: **~3 req/s in short bursts, 1 req/s sustained, never loop navigations.**
One page load fires ~10 requests of its own, so a navigation is not free.

Spotify's real anti-scraping lever appears to be TOTP secret rotation rather than
throttling, which is another reason to read tokens from the running app instead of
reimplementing its auth.

## Prior art

- [spicetify/cli](https://github.com/spicetify/cli) — the dominant client-mod project; calls `queryArtistOverview` with hardcoded hashes.
- [Pithaya/spicetify-apps](https://github.com/Pithaya/spicetify-apps/blob/main/libs/shared/src/graphQL/queries/query-artist-overview.ts) — typed pathfinder **response shapes**, the best reference for what comes back.
- [rukamori/ArchiveTune](https://github.com/rukamori/ArchiveTune/blob/main/spotifycore/src/moe/rukamori/archivetune/spotify/SpotifyHashProvider.kt) — maintained operation→hash catalogue with a remote update mechanism.
- [glomatico/votify](https://github.com/glomatico/votify/blob/main/votify/api/constants.py) — single-file map of pathfinder, spclient, clienttoken and the TOTP secret URL.
- [jpochyla/psst](https://github.com/jpochyla/psst), [spotbye/SpotiFLAC](https://github.com/spotbye/SpotiFLAC) — full auth chain in Rust and Go.
- [librespot wiki: Reverse engineering](https://github.com/librespot-org/librespot/wiki/Reverse-engineering) — how to pull the TOTP secret out of the debugger, if you ever must.
- [spotDL issue #2638](https://github.com/spotDL/spotify-downloader/issues/2638) — a hash going stale on 2026-02-06 and the fix, i.e. what breakage looks like.

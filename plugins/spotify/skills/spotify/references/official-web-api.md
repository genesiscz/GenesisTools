# The official Web API: what still works, and what died when

Check this before assuming a public endpoint will work. Two deprecation waves have gutted
it for apps without extended quota, and the failure is always a bare `403 Forbidden` with
no explanation.

## Wave one — 2024-11-27

[Official announcement](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).
Apps registered on or after that date lost:

- Related Artists
- Recommendations
- Audio Features, Audio Analysis
- Get Featured Playlists, Get Category's Playlists
- 30-second `preview_url` in multi-get responses
- algorithmic and editorial playlists

Extended-quota apps were grandfathered.
[TechCrunch framed it](https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/)
as a response to scraping.

## Wave two — 2026-02-11, existing apps migrated 2026-03-09

[Official migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
This is the bigger one and the source of most `403`s seen today:

- **All batch endpoints removed**: `GET /tracks`, `/albums`, `/artists`, `/episodes`,
  `/shows`, `/audiobooks`, `/chapters`. Only one-at-a-time `/{id}` remains.
- Also removed: `new-releases`, `browse/categories`, `artists/{id}/top-tracks`,
  cross-user endpoints.
- Search `limit` capped at 10 (was 50).
- Removed Artist fields: `followers`, `popularity`.
- The Dev Mode app owner must hold Premium; the app is capped at 5 test users.

## Measured on a Dev Mode app, 2026-08-13

| Request | Result |
|---|---|
| `GET /v1/artists/{id}` | `200` — but only `external_urls, href, id, images, name, type, uri` |
| `GET /v1/albums/{id}` | `200` |
| `GET /v1/search?q=…&type=artist` | `200` |
| `GET /v1/artists?ids=…` | `403` |
| `GET /v1/tracks?ids=…` | `403` |
| `GET /v1/browse/categories` | `403` |
| composio's shared Spotify OAuth app, saved tracks / top tracks | `403 Insufficient client scope` — its app lacks `user-library-read` and `user-top-read` |
| web-player token against `api.spotify.com` | `429` on the first call |

## What this means in practice

- **Play counts**: not in the Web API at all, at any tier. Only `popularity` (0-100).
  The internal `playcount` field is the only source. See `pathfinder-api.md`.
- **Genres**: absent on Dev Mode artist objects. See `genres.md`.
- **Bulk anything**: gone. Fetching 4000 tracks one `/{id}` call at a time is 4000
  requests against a documented rate limit; the internal API does it in 85.
- **Client credentials still works** for minting a token, and single-object reads still
  work, so the public API remains fine for one-off lookups — just not for a library.

Spotify's own [rate-limit page](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
describes a rolling 30-second window with `429` + `Retry-After` and publishes no numeric
threshold. Developer reports describe it as account-wide rather than per-app.

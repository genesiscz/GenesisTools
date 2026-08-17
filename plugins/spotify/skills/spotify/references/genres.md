# Genres: Spotify has none, so where do they come from

## Spotify is a dead end, both surfaces

Measured 2026-08-13.

**Internal API.** `queryArtistOverview`'s response contains zero fields matching
`/genre/i`, and none of the 104 operation names mention genre, tag, mood, category, taste
or affinity. Independently confirmed by reading the reverse-engineered `Artist` type in
[Pithaya/spicetify-apps](https://github.com/Pithaya/spicetify-apps/blob/main/libs/shared/src/graphQL/queries/query-artist-overview.ts)
end to end.

**Public Web API.** `GET /v1/artists/{id}` on a Dev Mode app returns only
`external_urls, href, id, images, name, type, uri` — no `genres`, no `popularity`, no
`followers`. Batch endpoints (`/v1/artists?ids=`, `/v1/tracks?ids=`) return `403`.

> **Keep this claim honest.** Spotify's
> [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
> lists only `followers` and `popularity` as removed Artist fields — *not* `genres` — and
> [a 2016 issue](https://github.com/spotify/web-api/issues/157) shows `genres` has been
> sparse for many artists since long before any quota policy. So "the restricted tier
> strips genres" is not documented anywhere. What is measurable: for a Dev Mode app the
> key is absent entirely, and the internal API has no such field. Unavailable either way.

**Every Noise At Once** (glenn mcdonald's genre space, built by mining Spotify's own
clustering) would be the ideal source and is what several projects scrape. It is currently
unusable: `everynoise.com/artistprofile.cgi` and `/lookup.cgi` return `403` to curl and to
Jina alike. Worth re-testing occasionally.

## What actually works: two sources, different jobs

| Source | Key needed | Rate | Coverage on a phonk/DnB-heavy 3157-artist library | Failure mode |
|---|---|---|---|---|
| MusicBrainz | no | 1 req/s | **~40% of artists** carry any tag | fuzzy search returns a different artist |
| Last.fm | no (HTML) or free key (API) | 1 req/s HTML, ~5 req/s API | high, including the electronic long tail | name-only matching, tag cloud full of noise |

They are complementary, not redundant. Loboski has **no** MusicBrainz tags and is
`drum and bass, electronic` on Last.fm. Kordhell is `phonk, drift phonk` on both.

### MusicBrainz: precise, sparse

`GET ws/2/artist?query=artist:"NAME"&limit=3&fmt=json` returns candidates with `score` and
inline `tags`. Accept a hit **only** when the normalised name matches exactly and
`score >= 90` — MusicBrainz search is fuzzy enough that "Ripple" or "Gemini" resolves to a
different act, and a wrong genre is worse than a missing one.

Do **not** follow up untagged matches with `GET ws/2/artist/{mbid}?inc=tags+genres`. Tested
on three artists that matched but had no tags: all returned empty `tags` **and** empty
`genres`. The search result already carries everything MusicBrainz knows, so the follow-up
would double the crawl for nothing.

Requires a real `User-Agent` identifying you; 1 request/second is
[their documented limit](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).

### Last.fm: broad, noisy

With a free API key: `artist.getTopTags` gives tags with weights.
Without one: `https://www.last.fm/music/<artist>/+tags` carries the same cloud in HTML —
scrape `href="/tag/…"` in page order, which is popularity order. This is what beets'
`lastgenre` plugin and similar tools do.

`502` on that page usually means "no such artist page", not an outage. Retrying it three
times with escalating backoff tripled a crawl's runtime for zero extra data — one retry,
then move on.

## Cleaning: the part that decides whether the output is usable

Both sources are folksonomies. Raw, the top "genres" of any library are `seen live`,
`favourites`, `2010s`, `american`, `all`. `src/spotify/lib/genres.ts` handles three jobs:

1. **Drop non-genres** — eras (`2010s`), countries and nationalities (`australia`,
   `swedish`), collection labels (`seen live`, `favourites`), moods and pure noise
   (`chill`, `epic`, `all`, `go`, `art`), role words (`dj`, `producer`, `remix`).
2. **Canonicalise** — `dnb`, `drum & bass`, `drum n bass`, `d&b` → `drum and bass`;
   `rap` → `hip hop`; `r&b` → `rnb`. Without this the counts split across spellings and
   every subgenre looks smaller than it is.
3. **Whitelist Last.fm** — keep a Last.fm tag only if it is in the vocabulary, where
   vocabulary = every genre MusicBrainz used anywhere in *this* library ∪ a seed list of
   electronic subgenres MusicBrainz is weak on (phonk, drift phonk, hardwave, sigilkore,
   riddim, neurofunk…). The vocabulary adapts to the library instead of being a fixed
   guess, and it is what stops a name collision from injecting `funk, soul, disco`.

Then take at most the top 8 Last.fm tags per artist — beyond that the cloud is mostly
long-tail personal tags.

## Merge rule

A track's genres = union of its artists' tags, MusicBrainz first (precise), Last.fm second
(fills gaps). Track-level coverage lands well above artist-level coverage because most
tracks have several artists, and remixes especially.

Report both numbers. "72% of tracks tagged" and "40% of artists tagged" are different
claims and only the first one is about the answer being given.

## If accuracy matters more than convenience

Get a free Last.fm API key and put it in `LASTFM_API_KEY`, not on the command line: an
argument is visible in shell history and to anyone running `ps`. `artist.getTopTags` returns
weights, which allows dropping tags below a weight threshold instead of relying on page
order, and the allowance is ~5 req/s instead of 1.

```bash
# Typed, not pasted: `export KEY=value` lands in shell history just as an argument does.
# `printf` for the prompt rather than `read -p`, because in zsh -p means "read from a
# coprocess" and the prompt form silently fails there.
printf 'Last.fm API key: '
read -rs LASTFM_API_KEY
echo
export LASTFM_API_KEY
tools spotify enrich lastfm -p me
```

Better still, keep it in a secret manager and export it from there, so it never exists in a
shell at all.

The `--key` flag still works for compatibility and warns on every use. Do not pass a real
key through it.

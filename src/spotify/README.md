# tools spotify

Deep analytics over a personal Spotify listening life, and taste compatibility between two
people. Nothing here calls Spotify at query time — two local sources feed it:

| Source | What it holds | How it got here |
|---|---|---|
| **Extended Streaming History** | every play since the account was created, with device, country, shuffle, skip and start/end reason | official export, requested at [spotify.com/account/privacy](https://www.spotify.com/account/privacy) |
| **Harvested library** | Liked Songs, each with its **global** stream count | the web player's own internal API, read from a logged-in browser tab |

Genres come from neither. Spotify exposes no genre data anywhere, so MusicBrainz and
Last.fm supply them.

## Start here

```bash
tools spotify profile add me --history ~/Spotify/streaming-history --data ~/Spotify/data
tools spotify doctor            # what exists, what is missing, the exact next command
tools spotify analytics summary # start here if you do not know what to ask
tools spotify ui                # the same reports in a browser, on port 3075
```

Every analytics command takes `--since` / `--until` / `--year`, `--top N`, `--artist`,
`--genre`, `--platform`, `--profile`, `--tz` and `--json`. Reach for `--json` when you need
to compute on the result rather than show it.

## What to run for what was asked

Every report lives under `analytics`. `export` is top-level, because it writes a file rather
than answering a question.

| Question | Command |
|---|---|
| most played songs / favourites | `analytics top songs` (`tracks` keeps releases separate, `songs` folds them) |
| top artists last year | `analytics top artists --since 2025-08-14` |
| what genres do I listen to | `analytics top genres` |
| my 2025 wrapped | `analytics wrapped 2025` |
| when do I listen | `analytics clock`, `analytics calendar`, `analytics seasons` |
| how much do I listen | `analytics summary`, `analytics timeline`, `analytics sessions` |
| what do I skip | `analytics skips` |
| what did I used to love | `analytics forgotten`, `analytics obsessions`, `analytics loyalty` |
| am I basic | `analytics mainstream`, `analytics gems` |
| describe my taste | `analytics dna`, eight axes on one screen |
| has my taste changed | `analytics shift 2019 2026`, compatibility with your past self |
| tell me about \<artist\> | `analytics artist "<name>"` |
| liked songs I never play | `analytics audit` |
| give me a file | `export songs --out ~/tracks.csv` |
| anything about two people | `analytics compat a b`, `analytics blend`, `analytics gift` |

## Two people

A second person needs **only their streaming-history export** — no harvest, no login,
nothing shared but a zip file they downloaded from their own account.

```bash
tools spotify profile add kaja --history ~/Downloads/kaja-export --label "Kája"
tools spotify analytics compat me kaja
tools spotify analytics compat me kaja --timeline --bucket quarter
tools spotify analytics blend me kaja --top 40   # the safe shared playlist
tools spotify analytics gift me kaja --top 25    # what to play her next
```

`compat` reports one blended percentage **and its four components** (genre cosine 0.40,
artist weighted-Jaccard 0.30, top-50 overlap 0.15, exact-song Jaccard 0.15), because a
single number hides which kind of agreement is happening. Two people can share almost no
exact recordings yet live in the same three genres all day. Quote the components alongside
the headline number.

Genres are a property of **artists**, so whichever profile has enrichment data lends its
tags to the other. A partner who only handed over a history export still gets a genre
profile.

## Reporting results honestly

- **`plays` is always personal; `playcount` is always global.** The library's `playcount` is
  the track's worldwide stream total, unrelated to how often this person played it. `gems`
  and `mainstream` are the only reports that mix them, and they label both sides.
- **A play means 30 seconds or more**, matching Spotify's own royalty threshold. Shorter
  events are counted separately as short plays.
- **Genre coverage is never 100%.** Every genre report carries how many plays had a genre.
  Quote that denominator.
- The same song on a single, an album and a compilation is three different track ids.
  `top tracks` splits them, `top songs` folds them.
- Global stream counts are **today's** totals, so `mainstream` shows a trend, not a
  historical level.
- The first year in the export always reads 100% novelty in `discovery`, because nothing
  precedes it.

## Adding data

```bash
tools spotify harvest --auto              # reads the library from a logged-in browser tab
tools spotify harvest                     # prints the same sequence to run by hand instead
tools spotify build --profile me          # raw harvest -> track library
tools spotify enrich --profile me         # MusicBrainz + Last.fm, ~1 req/s each, resumable
tools spotify history-merge --profile me  # join personal plays onto the liked-track library
```

The two enrichers hit different hosts, so they can run in parallel; budget about an hour for
3000 artists. Both are resumable and crawl recent artists first, so partial results are
usable.

> The harvest tokens and the `sp_dc` / `sp_key` cookies authorise the whole account. Keep
> them in page memory. Never write them to a file, a log, or a message.

## Layout

One core, three thin doors. `lib/reports/*` computes; the CLI, the HTTP routes and the
dashboard all call the same functions.

| Path | What it is |
|---|---|
| `index.ts` | the commander entry point |
| `commands/*.ts` | CLI adapters — parse flags, call a report, render or `out.result` |
| `lib/reports/*.ts` | every report as a pure function returning typed, serialisable data |
| `lib/history.ts` | export loader, local-time bucketing, aggregation, the parse cache |
| `lib/library.ts` | harvested library and the genre resolver |
| `lib/stats.ts` | similarity, entropy, sessions, streaks, rolling peaks |
| `lib/series.ts` | bucketing and sparkline series |
| `lib/enrich/*.ts` | MusicBrainz / Last.fm crawls and the merges they feed |
| `lib/profiles.ts` | the profile registry (`~/.genesis-tools/spotify/profiles.json`) |
| `render/*.ts` | terminal rendering: tables, bars, sparklines, heatmaps |
| `ui/` | the dashboard (TanStack Start, port 3075); `ui/routes/api/*` is the HTTP door |
| `page/*.ts` | browser payloads, evaluated as JS in the Spotify web player |
| `tests/*.test.ts` | end-to-end CLI checks on synthetic fixtures, plus unit tests for the HTTP door, the redaction boundary, the genre rules and the option guards |

## The dashboard is trusted-local

It binds to `127.0.0.1` (`DASHBOARDS.spotify.bindHost`), and that is load-bearing rather than
a default: there is no login and no session. Every report endpoint returns one person's whole
listening history, `/api/profiles` returns the filesystem paths it is read from, and the write
route's guard (JSON content type plus an Origin check) stops a cross-site form post but is not
authentication. Serving this on another interface would need real authentication first.

## Gotchas that cost real time

- **The first run parses ~110 MB and caches it**; later runs load in about 40 ms. The cache
  key is the export files' size and mtime, which catches every ordinary change (a new export
  is a different size, a re-download a different mtime) but is not content-addressed: a
  same-size replacement written with a preserved mtime would reuse the old parse.
  `tools spotify cache-clear` if you ever doubt it.
- **Timestamps in the export are UTC.** Everything day- or hour-shaped converts to the
  profile's timezone first, which is why `clock` and `calendar` need `--tz` to be right.
- **`evaluate_script` output arrives wrapped in a ```json fence** during a harvest. Strip it
  before parsing; `build` already does.
- **Hooking `window.fetch` to sniff tokens does not work** — the app captured its own
  reference at load. Read the network log instead.
- **Do not follow up untagged MusicBrainz matches** with `inc=tags+genres`; verified to
  return empty, so it doubles the crawl for nothing.
- **`everynoise.com` returns `403`** to curl and to Jina. It would be the best genre source
  if it ever came back; re-test occasionally.
- **Rate discipline for any crawl:** ~3 req/s in bursts, 1 req/s sustained, never loop
  navigations. A page-reload loop earned an `HTTP 503` Varnish `Backend.max_conn`.

After changing anything under `src/spotify/`, run `bun run test src/spotify/tests/cli.test.ts` —
it builds throwaway profiles in a temp directory and never touches the real config or cache.

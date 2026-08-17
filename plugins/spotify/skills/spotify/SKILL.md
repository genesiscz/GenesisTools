---
name: spotify
description: "Deep analytics over a personal Spotify listening life, and taste compatibility between two people, via `tools spotify`. Use this for ANY question about the user's music: most played tracks or artists, top songs of a year, genres, listening habits, when they listen, what they skip, what they have forgotten, hidden gems, how mainstream their taste is, their own Wrapped for any year, or exporting their library. Use it ALSO whenever a second person is involved — comparing two libraries, 'how compatible are our tastes', 'what should we listen to together', 'what should I show her', compatibility over time. Reach for it before writing any ad-hoc Spotify API call or parsing the streaming-history export by hand: the public Web API cannot return play counts or genres at all and its batch endpoints now 403, while this tool already has the data locally, 28 report commands over it, a dashboard on port 3075, and `play` to hear the tracks through the web player itself."
---

# `tools spotify`

Everything about a Spotify listening life, from data that is already the user's.

Nothing here calls Spotify at query time. Two local sources feed it:

| Source | What it holds | How it got here |
|---|---|---|
| **Extended Streaming History** | every play since the account was created, with device, country, shuffle, skip and start/end reason | official export, requested at [spotify.com/account/privacy](https://www.spotify.com/account/privacy) |
| **Harvested library** | Liked Songs, each with its **global** stream count | the web player's own internal API, read from a logged-in browser tab |

Genres come from neither. Spotify exposes no genre data anywhere — not in the Web API, not in
any of the 104 internal operations — so MusicBrainz and Last.fm supply them.

## Use the CLI

```bash
tools spotify --help
tools spotify analytics summary                     # start here if you do not know what to ask
tools spotify analytics top artists --year 2026
tools spotify analytics compat me kaja
```

Every analytics command takes `--since` / `--until` / `--year`, `--top N`, `--artist`,
`--genre`, `--platform`, `--profile`, `--tz` and `--json`. Reach for `--json` when you need to
compute on the result rather than show it. Full flag reference: `references/cli.md`.

## What to run for what they asked

Every command in this table is an `analytics` subcommand — `top songs` means
`tools spotify analytics top songs` — except the `ui` and `play` rows.

| They asked | Run |
|---|---|
| "my most played songs / favourites" | `top songs` (`tracks` keeps releases separate, `songs` folds them) |
| "top artists last year" | `top artists --year 2025` (`--since` alone has no upper bound, so it would run to today) |
| "what genres do I listen to" | `top genres` |
| "my 2025 wrapped" | `wrapped 2025` |
| "when do I listen" | `clock`, `calendar`, `seasons` |
| "how much do I listen" | `summary`, `timeline`, `sessions` |
| "what do I skip" | `skips` |
| "what did I used to love" | `forgotten`, `obsessions`, `loyalty` |
| "am I basic" | `mainstream`, `gems` |
| "describe my taste" | `dna` — eight axes on one screen |
| "has my taste changed" | `shift 2019 2026` — compatibility with your past self |
| "tell me about \<artist\>" | `artist "<name>"` |
| "liked songs I never play" | `audit` |
| "give me a file" | `export songs --out ~/tracks.csv` |
| "show me" / "in a browser" | `tools spotify ui` — every report on port 3075 |
| "play them / let me hear it" | `tools spotify play run` — samples each track via the browser's own player; `play plan` sets windows like `40:30` (seek 0:40, hear 30s), `references/cli.md` § Playback |
| anything about two people | `compat a b`, `blend`, `gift` — see below |

A single lookup does not need a crawl and a comparison does not need a fresh harvest. The data
on disk answers almost everything; only add data when `tools spotify doctor` says it is
missing.

## Two people

This is the part worth reading before using. A second person needs **only their streaming
history export** — no harvest, no login, nothing shared but a zip file they downloaded from
their own account.

```bash
tools spotify profile add kaja --history ~/Downloads/kaja-export --label "Kája"
tools spotify analytics compat me kaja
tools spotify analytics compat me kaja --timeline --bucket quarter
tools spotify analytics blend me kaja --top 40          # the safe shared playlist
tools spotify analytics gift me kaja --top 25           # what to play her next
```

`compat` reports one blended percentage **and its four components**, because a single number
hides which kind of agreement is happening. Two people can share almost no exact recordings yet
live in the same three genres all day. Read `references/compatibility.md` before interpreting a
score, and quote the components alongside the headline number.

Genres are a property of **artists**, so whichever profile has enrichment data lends its tags to
the other. A partner who only handed over a history export still gets a genre profile, but only
for the artists that appear in the enriched library: an artist nobody has tagged carries no
genre for either person. Quote the coverage figure the report prints, not the ranking alone.

## Reporting results honestly

Three traps, all easy to fall into and all misleading:

- **`plays` is always personal; `playcount` is always global.** The library's `playcount` is the
  track's worldwide stream total, unrelated to how often this person played it. Never present
  one as the other. `gems` and `mainstream` are the only commands that mix them, and they label
  both sides.
- **A play means 30 seconds or more**, matching Spotify's own royalty threshold. Shorter events
  are counted separately as short plays, which matters because auditioning tracks in a browser
  generates thousands of 3-second events that would otherwise read as heavy listening.
- **Genre coverage is never 100%.** Every genre command prints how many plays carried a genre.
  Quote that denominator; a ranked list without it overstates its own authority.

Also worth stating when it applies:

- The same song on a single, an album and a compilation is three different track ids. `top
  tracks` splits them, `top songs` folds them. If a number looks lower than expected, that is
  usually why.
- Global stream counts are **today's** totals. A 2016 play of a song that later blew up is
  measured with its current number, so `mainstream` shows a trend, not a historical level.
- The first year in the export always reads 100% novelty in `discovery`, because nothing
  precedes it.

## Adding data

Run `tools spotify doctor` first — it prints, per profile, what exists and the exact next
command. It only ever reads; when it finds a gap it prints the fix rather than applying it.

```bash
tools spotify harvest                     # prints the browser sequence; it cannot be automated headlessly
tools spotify build --profile me          # raw harvest -> track library
tools spotify enrich --profile me         # MusicBrainz + Last.fm, ~1 req/s each, resumable
tools spotify history-merge --profile me  # personal plays joined onto the liked-track library
```

The two enrichers hit different hosts, so run them in parallel; budget about an hour for 3000
artists. Both are resumable and crawl recent artists first, so partial results are usable.

> The harvest tokens and the `sp_dc` / `sp_key` cookies authorise the whole account. Keep them
> in page memory. Never write them to a file, a log, or a message.

## Files

One core, three thin doors: `lib/reports/*` computes, and the CLI, the HTTP routes and the
dashboard all call the same functions.

| Path | What it is |
|---|---|
| `src/spotify/index.ts` | the CLI entry point (commander) |
| `src/spotify/commands/*.ts` | one module per command group; parse, call a report, render |
| `src/spotify/lib/reports/*.ts` | every report as a pure function returning typed data |
| `src/spotify/lib/history.ts` | export loader, local-time bucketing, aggregation, parse cache |
| `src/spotify/lib/library.ts` | harvested library and the genre resolver |
| `src/spotify/lib/stats.ts` | similarity, entropy, sessions, streaks, rolling peaks |
| `src/spotify/lib/enrich/*.ts` | MusicBrainz / Last.fm crawls and the merges they feed |
| `src/spotify/render/*.ts` | terminal tables, bars, sparklines, heatmaps |
| `src/spotify/ui/` | the dashboard; `ui/routes/api/*` is the HTTP door |
| `src/spotify/page/*.ts` | browser payloads, evaluated as JS in the page — no type annotations |
| `src/spotify/tests/cli.test.ts` | end-to-end check on synthetic two-person fixtures |
| `references/cli.md` | every command and flag |
| `references/compatibility.md` | how the score is computed and how to read it |
| `references/pathfinder-api.md` | the internal API: auth, hashes, response shapes, rate limits |
| `references/genres.md` | why Spotify has no genres and how the two sources compare |
| `references/official-web-api.md` | what the public API can still do, and what died when |

## Gotchas that cost real time

- **The first run parses ~110 MB and caches it**; later runs load in about 40 ms. The cache key
  is the export files' size and mtime, so a stale cache is not reachable.
  `tools spotify cache-clear` if you ever doubt it.
- **Output is coloured only on a TTY.** Piping to a file or to `jq` is already clean;
  `NO_COLOR=1` forces it off.
- **Timestamps in the export are UTC.** Everything day- or hour-shaped converts to the profile's
  timezone first, which is why `clock` and `calendar` need `--tz` to be right.
- **`evaluate_script` output arrives wrapped in a ```json fence** during a harvest. Strip it
  before parsing; `build` already does.
- **Hooking `window.fetch` to sniff tokens does not work** — the app captured its own reference
  at load. Read the network log instead.
- **Do not follow up untagged MusicBrainz matches** with `inc=tags+genres`; verified to return
  empty, so it doubles the crawl for nothing.
- **`everynoise.com` returns `403`** to curl and to Jina. It would be the best genre source if
  it ever came back; re-test occasionally.
- **Rate discipline is per host, not one global number:**
  - **MusicBrainz: 1 req/s, hard.** Their published limit; the enricher already paces to it.
  - **Last.fm:** ~5 req/s with an API key, ~1 req/s when scraping the tag page.
  - **Spotify's own web player:** ~3 req/s in short bursts, 1 req/s sustained, and never loop
    navigations. A page-reload loop earned an `HTTP 503` Varnish `Backend.max_conn`.
- **One song key, everywhere.** Song and album aggregation go through `songKey` in
  `lib/history.ts`. The standalone skill this was ported from keyed `bySong` on `name\0artist`
  while three consumers rebuilt the key with a space, which silently emptied `top songs`'
  trend column and made `track <query>` compute its peak over zero plays. Pinned by
  `tests/cli.test.ts`.

After changing anything under `src/spotify/`, run `bun run test src/spotify/tests/cli.test.ts` —
it builds throwaway profiles in a temp directory and never touches the real config or cache.

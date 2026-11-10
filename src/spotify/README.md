# tools spotify

Deep analytics over a personal Spotify listening life, and taste compatibility between two
people. It answers "what did I play most", "when do I listen", "what have I forgotten" and
"how compatible are we" from data you already own, and it can play a list of tracks through
the web player so you hear the answer. Nothing here calls Spotify at query time: two local
sources feed it.

- **Extended Streaming History**: every play since the account was created, with device,
  country, shuffle, skip and start/end reason. It is the official export, requested at
  [spotify.com/account/privacy](https://www.spotify.com/account/privacy).
- **Harvested library**: Liked Songs, each with its **global** stream count. It comes from
  the web player's own internal API, read from a logged-in browser tab.

Genres come from neither. Spotify exposes no genre data anywhere, so MusicBrainz and Last.fm
supply them.

## Quick start

```bash
# register your export; the harvest folder (--data) is optional
tools spotify profile add me --history ~/Spotify/streaming-history --data ~/Spotify/data
# what exists, what is missing, the exact next command
tools spotify doctor
# start here if you do not know what to ask
tools spotify analytics summary
# your top artists of one calendar year
tools spotify analytics top artists --year 2025
# taste compatibility, after `profile add alice --history <her export>`
tools spotify analytics compat me alice
# every report in a browser, on port 3075
tools spotify ui
```

A profile with only a history export already supports every history-based report. The
harvested library (`--data`) adds the library reports (`audit`, `gems`, `mainstream`,
`saves`), the global stream counts and the genre enrichment.

## What to run for what was asked

Every report lives under `analytics`. `export` is top-level, because it writes a file rather
than answering a question.

| Question | Command |
|---|---|
| most played songs, favourites | `analytics top songs` (see Rankings: `songs` vs `tracks`) |
| top artists last year | `analytics top artists --year 2025` |
| what genres do I listen to | `analytics top genres` |
| my 2025 Wrapped | `analytics wrapped 2025` |
| when do I listen | `analytics clock`, `analytics calendar`, `analytics seasons` |
| how much do I listen | `analytics summary`, `analytics timeline`, `analytics sessions` |
| what do I skip | `analytics skips` |
| what did I use to love | `analytics forgotten`, `analytics obsessions`, `analytics loyalty` |
| what should I listen to next | `analytics recommend`; the Discover page in the dashboard |
| am I basic | `analytics mainstream`, `analytics gems` |
| describe my taste | `analytics dna`, eight axes on one screen |
| has my taste changed | `analytics shift 2019 2026`, compatibility with your past self |
| tell me about an artist | `analytics artist "<name>"` |
| liked songs I never play | `analytics audit` |
| give me a file | `export songs --out ~/tracks.csv` |
| let me hear them | `play plan new <name> --from gems`, then `play run` |
| anything about two people | `analytics compat a b`, `analytics blend a b`, `analytics gift a b` |

`--since` alone has no upper bound, so `--since 2025-01-01` runs to today. Use `--year` for
one calendar year.

## Commands

`tools spotify --help` lists the groups, and `tools spotify <command> --help` prints every
flag with its default.

### Profiles: whose data a report reads

```text
tools spotify profile list                 # the default when you type just `profile`
tools spotify profile add <name> \
    --history <dir> \
    --data <dir> \
    --label "Alice" \
    --tz Europe/Prague
tools spotify profile show [name]          # what a profile points at, and how much data it has
tools spotify profile use <name>           # make it the default profile
tools spotify profile rm <name>            # forget the registration; no file is deleted
```

- `--history` takes the unzipped export folder, the folder above it, or the folder that
  holds the `Streaming_History_Audio_*.json` files directly.
- `--data` is the harvest folder (`spotify_library*.jsonl`). It is optional.
- `--tz` sets the IANA timezone for day and hour bucketing. A new profile gets
  `Europe/Prague`. `add` on an existing profile updates only the flags you pass, so it keeps
  the old timezone when you leave `--tz` out.
- The first profile you add becomes the default. `profile rm` of the default profile makes
  the first remaining profile the default.
- `list`, `add` and `show` take `--json`.

### Analytics: every report

Every `analytics` command takes the same filter flags:

| Flag | Meaning |
|---|---|
| `-p, --profile <name>` | whose data to read (default: the configured profile) |
| `-s, --since <date>` | plays on or after this local date (`YYYY-MM-DD`) |
| `-u, --until <date>` | plays on or before this local date |
| `-y, --year <year>` | one whole calendar year |
| `-n, --top <n>` | rows the table prints (default 20; see below) |
| `--artist <name>` | artists whose name contains this, case-insensitive |
| `--genre <genre>` | one genre, resolved per play |
| `--platform <name>` | one device kind (see below) |
| `--min-ms <ms>` | the bar a play must clear (default 30000) |
| `--all-plays` | include plays under the 30-second bar |
| `--exclude-incognito` | drop private-session plays |
| `--tz <zone>` | IANA timezone for day and hour bucketing |
| `--json` | machine-readable output |

- `--top` defaults to 20 rows, except on `compat` (15), `blend` (30), `gift` (25) and
  `shift` (12). `--help` prints no default for it.
- `--platform` matches the device kind the tool derives from the export: `mac`, `ios`,
  `android`, `windows`, `linux`, `web`, `speaker` or `unknown`. A platform name it does not
  know keeps its first word, so other kinds can appear too.
- On `compat`, `blend` and `gift` the two people are positional arguments, so `--profile` is
  ignored there.

**Rankings**

```text
tools spotify analytics top [tracks|songs|artists|albums|genres] \
    --by plays|hours \
    --min <plays> \
    --csv <path> \
    --no-trend
```

For example, `tools spotify analytics top songs --by hours --no-trend`.

- `top` with no kind ranks `tracks`.
- `tracks` keys on the Spotify track id, so a song on a single, an album and a compilation
  shows three times. `songs` folds them and adds a `rel` column with the release count. Use
  `songs` for "my favourites" and `tracks` when the exact recording matters.
- `genres` counts a play once per genre it carries, so shares sum above 100%. It prints the
  share of plays that carried any genre at all.
- The `trend` column is a sparkline of that row's own activity across the window.
  `--no-trend` skips it. `--min` defaults to 1, `--by` to `plays`.
- `--csv` writes the full ranking, not just the printed rows.

**Time**

| Command | What it shows |
|---|---|
| `timeline [-b <size>] [--by plays\|hours]` | plays over time (see below) |
| `clock` | the 7 x 24 weekly heatmap, peak hour, night-owl and weekend shares |
| `calendar` | one cell per day, one block per year |
| `seasons` | the month-of-year rhythm across all years, and what each season sounds like |

`timeline -b` takes `day`, `week`, `month`, `quarter` or `year`. Without it, the bucket fits
the window.

**Habits**

| Command | What it shows |
|---|---|
| `summary` (alias `stats`) | the one-screen lifetime overview: hours, per-year shape, streaks |
| `behavior` (alias `habits`) | devices, shuffle, offline, private sessions, track starts and ends |
| `skips [--min <starts>]` | artists and tracks you start but do not finish |
| `sessions [--gap <minutes>]` | listening sittings; silence longer than `--gap` ends one |
| `streaks` | consecutive listening days, and the silences between them |

`summary` also shows how concentrated your listening is. `skips` defaults to `--min 12`, and
`sessions` to `--gap 30`. A **skip** is a start that ended under 30 seconds or on the forward
button. The export's own `skipped` flag is null across
most of the archive, so the rate does not use it.

**Biography**

| Command | What it shows |
|---|---|
| `discovery` | how much of each year was music you had never heard before |
| `firsts [--min <plays>]` | the day each big artist entered your life |
| `forgotten [--min <plays>] [--quiet-months <n>]` | tracks you wore out once and left alone since |
| `obsessions [--window <days>] [--min <plays>]` | each song's densest window, each month's song |
| `loyalty [--min <plays>]` | ride-or-die artists versus phases you grew out of |

`firsts` defaults to `--min 60`, and `loyalty` to `--min 40`. `forgotten` defaults to
`--min 15` and `--quiet-months 18`. `obsessions` defaults to `--window 30` and `--min 6`.
The song-of-the-month table in `obsessions` is often the most
interesting output in the whole tool.

**Composite views**

```text
tools spotify analytics dna                       # alias: fingerprint
tools spotify analytics shift <from> <to> [--min <plays>]
```

- `dna` axes are all ratios in `[0,1]`: diversity, concentration, novelty, obscurity,
  loyalty, nocturnality, restlessness, repetition. Obscurity is log-scaled between 1 thousand
  and 1 billion global streams, because raw counts span six orders of magnitude.
- `shift` runs the compatibility maths against the same person in two periods. It reports
  **continuity** (how much of the old taste survived) and its complement, **change**. A
  period is a year (`2019`) or a range (`2019-06-01:2019-12-31`). An artist needs `--min`
  plays in a period to be listed (default 10). The "only in" tables list artists present in
  one window and absent from the other; they are not first-ever discoveries (use `firsts`).

**Deep dives**

```text
tools spotify analytics artist "<name>"    # arc, top tracks, peak, share of your life
tools spotify analytics track "<title>"    # when a song landed, peaked and faded
tools spotify analytics search "<text>"    # anything you have ever played, by title or artist
tools spotify analytics wrapped [year]     # your own Wrapped for any year, computed offline
```

**Recommendations**

```text
tools spotify analytics recommend --method <name>
```

For example, `tools spotify analytics recommend --method old-loves --min 80`. The methods:

- `bursts` (the default): artists you liked 2 or more songs of within a couple of weeks,
  ranked higher the less you explored them since. Flags: `--window <days>` (14) and
  `--min <songs>` (2).
- `unfinished`: artists you replay hard and rarely skip, but know only a few songs of.
  Flag: `--min <plays>` (40).
- `old-loves`: artists that once filled a big part of a year and then went quiet. Flags:
  `--min <plays>` (50) and `--quiet-months <n>` (12).
- `neighbours`: artists that turn up in the same sessions as your favourites but that you
  rarely play alone. Flag: `--gap <minutes>` (30).

`bursts` needs a harvested library; the other three need only the history. A bare `--method`
or an unknown name opens a picker on a terminal, and lists the valid names otherwise.
`harvest --artists` adds the top songs of each pick, so a recommendation can name songs to
try.

**Library, where the two sources meet** (these need a harvested library)

| Command | What it shows |
|---|---|
| `audit` | liked but never played, played but never liked, and duplicate saves |
| `gems [--min <plays>] [--max-global <n>]` | favourites the rest of the world has not found |
| `mainstream [--min <plays>]` | how popular your taste is, and whether it drifts |
| `saves` | when you added things to the library, and how fast it grew |

`gems` defaults to `--min 8` and `--max-global 1000000`. `mainstream` defaults to `--min 30`.

### Two people

A second person needs **only their streaming-history export**: no harvest, no login, nothing
shared but a zip file they downloaded from their own account.

```text
tools spotify analytics compat <a> <b> [--timeline] [-b month|quarter|year] [--min-plays <n>]
tools spotify analytics blend <a> <b> [--min <plays each>]
tools spotify analytics gift <from> <to>
```

```bash
tools spotify profile add alice --history ~/Downloads/alice-export --label "Alice"
tools spotify analytics compat me alice
tools spotify analytics compat me alice --timeline --bucket quarter
tools spotify analytics blend me alice --top 40     # the safe shared playlist
tools spotify analytics gift me alice --top 25      # what to play her next
```

- `compat` (alias `compare`) prints one score and its four parts. `--timeline` scores each
  period separately (bucket default `quarter`) and skips a bucket thinner than `--min-plays`
  (default 40) on either side.
- `blend` is the safe shared playlist: songs both people actually play, best matches first.
  Each side needs `--min` plays of a song (default 2).
- `gift` lists your tracks the other person has never heard, scored by their taste.

`compat` reports one blended percentage **and its four components**: genre cosine 0.40,
artist weighted Jaccard 0.30, top-50 overlap 0.15 and exact-song Jaccard 0.15. A single
number hides which kind of agreement is happening: two people can share almost no exact
recordings yet live in the same three genres all day. Quote the components with the headline
number.

Genres are a property of **artists**, so whichever profile has enrichment data lends its
tags to the other. A partner who only handed over a history export still gets a genre
profile, but only for artists in the enriched library. Quote the coverage figure the report
prints.

### What the numbers mean

- **`plays` is always personal; `playcount` is always global.** The library's `playcount` is
  the track's worldwide stream total, unrelated to how often this person played it. `gems`
  and `mainstream` are the only reports that mix them, and they label both sides.
- **A play means 30 seconds or more**, matching Spotify's own royalty threshold. Shorter
  events count separately as short plays. This matters because auditioning tracks in a
  browser makes thousands of 3-second events that would otherwise read as heavy listening.
- **Genre coverage is never 100%.** Every genre report prints how many plays had a genre.
  Quote that denominator.
- The same song on a single, an album and a compilation is three track ids. `top tracks`
  splits them, `top songs` folds them. If a number looks low, that is usually why.
- Global stream counts are **today's** totals, so `mainstream` shows a trend, not a
  historical level.
- The first year in the export always reads 100% novelty in `discovery`, because nothing
  precedes it.

### Data pipeline: get the library and the genres

```bash
# per profile: what exists, what is missing, the next command (reads only)
tools spotify doctor
# read Liked Songs from a signed-in browser over CDP
tools spotify harvest --auto --profile me
# print the manual steps that --auto automates
tools spotify harvest
# raw harvest -> track library and artist index
tools spotify build --profile me
# MusicBrainz + Last.fm genre tags, resumable
tools spotify enrich --profile me
# join personal plays onto the liked-track library
tools spotify history-merge --profile me
```

⚠️ `build` reads `sp_library_raw.json` first when it exists, and overwrites `spotify_library.jsonl` with it. A raw
file left from an earlier manual harvest therefore replaces the library that `harvest --auto` just wrote, and
`enrich` then works on the old library. Move the raw file out of the data folder before `build`.

- `doctor [--json]` reads only. It prints the fix for each gap instead of applying it.
- `harvest --auto` writes `spotify_library.jsonl` into the profile's data folder. Its flags
  are `-p`, `--out <path>`, `--browser-url <url>` and `--json`. Without `--auto`, `harvest`
  prints the manual guide.
- `harvest --artists` fetches the top songs of the Discover picks into the artist catalogue.
  Without `--auto` it reads public embed pages and needs no browser. With `--auto` it goes
  through the web player, which adds play counts, covers and releases. `--per-method <n>`
  (40) sets how many picks of each method to fetch, and `--refresh` fetches catalogued
  artists again.
- `build [-p] [--since <date>] [--json]` converts `sp_library_raw.json` into
  `spotify_library.jsonl` when the raw file exists (it overwrites the JSONL), else reads the
  JSONL as it is, and writes `artists.json`. Tracks saved since `--since` are crawled
  first.
- `enrich [source] [-p] [--limit <n>]` takes `musicbrainz` (`mb`), `lastfm` (`lf`) or `both`
  (the default), then merges the tags onto the tracks.
- `genres-merge [-p] [--since] [--min <n>] [--top <n>] [--json]` re-merges tags onto tracks
  after you edit the genre vocabulary.
- `history-merge` writes `spotify_library.full.jsonl`, the only file with both personal plays
  and global counts on one row. Flags: `-p`, `--history <dir>`, `--since`,
  `--by tracks|artists|genres`, `--top <n>` (25) and `--json`.
- `export [what]` writes `tracks`, `songs`, `artists` or `library`; with no kind it writes
  `songs`. It takes `--out <path>`, `--format csv|jsonl|json` and the filter flags.
- `cache-clear` drops the parsed-history cache. It rebuilds on the next command.

Notes:

- `enrich --key <key>` still works but is deprecated: a key on the command line lands in
  shell history and in `ps`. Set `LASTFM_API_KEY` instead.
- `enrich --limit` needs a whole number of at least 1. The run is resumable, so a partial
  run is useful.
- `export` without `--out` prints a capped preview (15 table rows, or 200 rows with `--json`,
  with `total`, `limit` and `truncated` in the payload). `--out` always writes every row. The
  file extension picks the format: `.jsonl` writes JSONL, `.json` writes JSON, and anything
  else writes CSV. `--format` overrides the extension.
- The two enrichers hit different hosts, so you can run `tools spotify enrich mb` and
  `tools spotify enrich lf` in two terminals at the same time. A plain `enrich` runs them one
  after the other. Budget about an hour for 3000 artists. Both crawl recent artists first,
  so partial results are usable.
- The auto harvest paces itself (about 90 seconds for 4200 tracks) and gives up after 10
  minutes.

> The harvest tokens and the `sp_dc` / `sp_key` cookies authorise the whole account. Keep
> them in page memory. Never write them to a file, a log, or a message. `harvest --auto`
> keeps them inside its own process and never mints a token: it reads the headers off a
> request the signed-in page already sent.

### Play: hear the tracks

`play run` drives the web player's own internal player (`playerAPI`) in your logged-in
browser over CDP. It clicks nothing in the page, and a track does not have to be in Liked
Songs. It needs the browser running with remote debugging (default endpoint
`http://127.0.0.1:9222`) and opens an `open.spotify.com` tab when none is open.

```bash
tools spotify play plan new gems-check --from gems -n 20 --windows 40:30
tools spotify play plan list               # every plan, newest first
tools spotify play plan set --plan gems-check --windows 10:3,20:3,30:3
tools spotify play run --plan gems-check --volume 40
tools spotify play status                  # done, failed, where to resume
tools spotify play run --resume            # skip what already played
tools spotify play plan rm gems-check
```

- `play plan new <name>` creates a plan and seeds its track list from a report. `--from`
  takes `top` (the default), `gems`, `forgotten`, `unplayed` or `recent`. `-n <count>` (30)
  is how many tracks to seed; it has nothing to do with `--from top`. Other flags:
  `--windows`, `--seek`, `--play`, `--tracks <path>`, `--quiet-months` (12, for
  `--from forgotten`), `--between <ms>`, `--no-queue`, `--note`, `--json` and the filter
  flags.
- `play plan list [--json]` lists every plan, newest first. `●` marks the one `run` uses.
- `play plan set` shows a plan, and only `--windows`, `--seek`, `--play`, `--tracks`,
  `--queue`/`--no-queue` and `--between` change it. It also takes `--plan` and `--json`. It
  is the default, so `play plan --windows …` edits the newest plan.
- `play plan rm <name>` (alias `remove`, takes `--json`) deletes the plan and the track list
  this tool seeded for it.
- `play run` plays each track across its sample windows and journals progress. Its flags
  are `--plan`, `--tracks`, `--windows`, `--seek`, `--play`, `--queue`/`--no-queue`,
  `--start <i>` (0), `--end <i>`, `--resume`, `--restart`, `--between`, `--browser-url` and
  `--volume <0-100>`. The volume is restored afterwards.
- `play status [--plan] [--tracks] [--json]` prints progress for a plan or a tracks file.
- `play harvest` prints the same library harvest guide as `tools spotify harvest`.

Notes:

- A window is `start:duration` in seconds: `40:30` means "seek to 0:40 and listen for 30
  seconds". A new plan without `--windows` uses `10:3,20:3,30:3`, queues the whole run, and
  pauses 600 ms between tracks.
- There is no "active plan" pointer. `run`, `status` and `plan set` use the **newest** plan:
  the one with the newest creation date (the date in its file name). Among plans made on the
  same day, the one written last wins. Editing an older plan keeps its file name and date,
  so it does not make that plan the newest. Pass `--plan` when it matters.
- When no plan exists yet, a change through `plan set` creates one named `default`.
- `plan rm` deletes a `.tracks.json` only when this tool seeded it. A tracks file you named
  with `--tracks` is never deleted, and the command says which case it took.
- A tracks file is `[{uri, name?, artists?, windows?}]` or `{all: [...]}`. A track's own
  `windows` array overrides the plan's.
- Progress is journalled per tracks file, so `--resume` skips what already played and
  `--restart` wipes that file's progress first. `run` flags default from the plan.

### Dashboard

```bash
tools spotify ui                           # start in the background and open http://localhost:3075
tools spotify ui status                    # pid, port, uptime, launchd state
tools spotify ui logs -n 200               # the last lines of the background log
tools spotify ui down                      # stop it (alias: stop)
```

`ui` (alias `dashboard`) also has `up [-f] [-p <port>] [--force] [--no-open]`, `restart`,
`attach [-n <lines>]`, `open [--no-qr] [--no-open] [-q key=value]`, `install` (a launchd job
that survives a reboot) and `uninstall`. `tools services up` starts it together with the
other GenesisTools dashboards, on the default port only (see `SPOTIFY_UI_PORT` under
Configuration).

Its pages are Overview, Rankings, Time, Habits, Biography, Library, DNA, Wrapped, Together,
Discover, Explore and Settings. Every report page is the same report the CLI prints, over
HTTP at `/api/report/<name>` with the flags as query parameters:
`/api/report/top?kind=artists&year=2025` answers what
`tools spotify analytics top artists --year 2025 --json` prints. A parameter takes either
spelling (`?min-ms=1000` or `?minMs=1000`). The profile and the window are picked in the
header and apply to every report page. **Settings** edits the profile registry through
`/api/profiles`, and is the one place the dashboard writes anything.

**The dashboard is trusted-local.** It binds to `127.0.0.1` (`DASHBOARDS.spotify.bindHost` in
`src/utils/ui/dashboards.ts`), and that is load-bearing rather than a default: there is no
login and no session. Every report endpoint returns one person's whole listening history,
`/api/profiles` returns the filesystem paths it is read from, and the write route's guard (a
JSON content type plus an Origin check) stops a cross-site form post but is not
authentication. Serving this on another interface would need real authentication first.

## How it works

One core, three thin doors. `lib/reports/*` computes; the CLI, the HTTP routes and the
dashboard all call the same functions.

**Where data lives**

| Path | What it is |
|---|---|
| `~/.genesis-tools/spotify/profiles.json` | the profile registry |
| `~/.genesis-tools/spotify/cache/` | parsed-history caches, `<profile>-<16 hex>.json` |
| `~/.genesis-tools/spotify/artist-catalog.json` | artist pages from `harvest --artists` |
| `~/.genesis-tools/spotify/play/` | plans and their progress (see below) |
| the profile's `--history` folder | the export, read only |
| the profile's `--data` folder | the harvest and every file built from it (see below) |

- `SPOTIFY_CONFIG_PATH` overrides the registry path, and `SPOTIFY_CACHE_DIR` the cache
  folder.
- The artist catalogue is shared by all profiles.
- The play folder holds the plans `<date>-<name>.json`, the seeded track lists
  `<date>-<name>.tracks.json`, `progress.jsonl` and `state.json`.
- The data folder holds `sp_library_raw.json`, `spotify_library.jsonl`, `artists.json`,
  `mb_artists.jsonl`, `lf_artists.jsonl`, `spotify_library.genres.jsonl` and
  `spotify_library.full.jsonl`.

`GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` tree. Reading the registry never
writes it: on a first run with no registry, the tool imports
`~/.config/me-spotify/profiles.json` (left by the older standalone skill) in memory, or else
builds a `me` profile from `$SPOTIFY_EXPORT_DIR` or `~/Documents/Spotify` when one of them
holds `streaming-history/` or `data/`. The file is written on the first `profile add`, `use`
or `rm`, or a save on the Settings page.

**What it calls**

- Reports call nothing over the network. They read the local files above.
- `harvest --auto`, `harvest --artists --auto` and `play run` attach over CDP to a Chrome or
  Brave that is already signed in to `open.spotify.com`. The library comes from
  `api-partner.spotify.com/pathfinder/v2/query`, which returns per-track global stream
  counts that the public Web API has never exposed.
- `harvest --artists` without `--auto` reads Spotify's public embed pages, with no browser.
- `enrich` calls MusicBrainz (1 request per second, their published limit) and Last.fm
  (the API with `LASTFM_API_KEY`, else the public tag page).
- Nothing costs money.

**Notes for crawling**

- Do not follow up untagged MusicBrainz matches with `inc=tags+genres`. It was verified to
  return empty, so it doubles the crawl for nothing.
- `everynoise.com` returns `403` to curl and to Jina. It would be the best genre source if it
  ever came back; re-test it now and then.
- Rate discipline is per host. MusicBrainz: 1 request per second, hard. Last.fm: about 5 per
  second with an API key, about 1 per second when scraping. Spotify's web player: about 3
  per second in short bursts, 1 per second sustained, and never loop navigations. A
  page-reload loop earned an `HTTP 503` Varnish `Backend.max_conn`.

**Source layout** (under `src/spotify/`)

| Path | What it is |
|---|---|
| `index.ts` | the commander entry point |
| `commands/*.ts` | CLI adapters: parse flags, call a report, render or `out.result` |
| `lib/reports/*.ts` | every report as a pure function returning typed, serialisable data |
| `lib/history.ts` | export loader, local-time bucketing, aggregation, the parse cache |
| `lib/library.ts` | harvested library and the genre resolver |
| `lib/stats.ts` | similarity, entropy, sessions, streaks, rolling peaks |
| `lib/series.ts` | bucketing and sparkline series |
| `lib/enrich/*.ts` | MusicBrainz and Last.fm crawls and the merges they feed |
| `lib/browser/*.ts` | the signed-in tab: token reading and `harvest --auto` |
| `lib/play/*.ts` | plans, seeding, the progress journal and the player driver |
| `lib/profiles.ts` | the profile registry |
| `render/*.ts` | terminal rendering: tables, bars, sparklines, heatmaps |
| `ui/` | the dashboard (TanStack Start); `ui/routes/api/*` is the HTTP door |
| `page/*.ts` | browser payloads, evaluated as JS in the Spotify web player |
| `tests/*.test.ts` | end-to-end CLI checks on synthetic fixtures, plus unit tests (see below) |

The unit tests cover the HTTP door, the redaction boundary, the genre rules and the option
guards. After changing anything under `src/spotify/`, run
`bun run test src/spotify/tests/cli.test.ts`. It builds throwaway profiles in a temp
directory and never touches the real config or cache.

## Configuration

| Variable | Effect |
|---|---|
| `SPOTIFY_PROFILE` | the default profile when no `-p` is passed (wins over the registry) |
| `SPOTIFY_CONFIG_PATH` | path to the profile registry; a leading `~` is expanded |
| `SPOTIFY_CACHE_DIR` | path to the parsed-history cache |
| `SPOTIFY_EXPORT_DIR` | where a first run looks for `streaming-history/` and `data/` first |
| `SPOTIFY_UI_PORT` | the port the dashboard server binds (default 3075); see below |
| `SPOTIFY_BROWSER_URL` | CDP endpoint for `harvest --auto` and `play run` |
| `LASTFM_API_KEY` | use the Last.fm API instead of scraping the tag page |
| `NO_COLOR` | no colour even on a terminal; output is already plain when piped |

- `SPOTIFY_EXPORT_DIR` is checked before `~/Documents/Spotify`.
- `SPOTIFY_BROWSER_URL` defaults to `http://127.0.0.1:9222`.
- `SPOTIFY_UI_PORT` moves only the server. The `tools spotify ui` launcher still checks
  readiness on 3075, so it warns after 90 seconds that the readiness check failed, while the
  server runs on your port. `ui up -p <port>` changes only the port the launcher checks, not
  the port the server binds. `tools services up` reports the spotify entry as failed while
  the variable moves the port. Keep the default port, or start the server yourself.

A profile holds a name, a label for report headings, the history folder, the data folder and
a timezone.

## For agents

- `--json` works on every analytics command, `export`, `doctor`, `harvest --auto`,
  `harvest --artists`, `build`, `genres-merge`, `history-merge`, `profile list|add|show`, the
  `play plan` subcommands and `play status`. A plain `harvest` ignores `--json` and prints
  the guide. An analytics payload holds the profile, the window and the rows; sets serialise
  as arrays. Reach for `--json` when you need to compute on the result rather than show it.
- **`--top` truncates the table only.** `--json` returns every row and records the requested
  number as `limit`, so asking for 20 forgotten tracks can hand the next step 1,401 of them,
  with nothing in the payload that looks like an error. Slice on `limit` yourself. `--csv`
  and `--out` also write the complete ranking.
- Errors print a message to stderr and exit 1. A missing profile or data folder names the
  exact `tools spotify profile add …` to run.
- `play run` also exits 1 when any track failed to play or the run aborted, even after it
  played the rest. `play status --json` gives `failed`, `remaining` and `nextIndex`.
- The plugin skill `spotify` (`plugins/spotify/skills/spotify/SKILL.md`) routes music
  questions here. Its `references/` folder holds the deeper material: `cli.md`,
  `compatibility.md` (how the score is computed and calibrated), `genres.md` (why Spotify has
  no genres and how the two sources compare), `pathfinder-api.md` (the internal API: auth,
  operation hashes, response shapes, rate limits) and `official-web-api.md` (what the public
  API can still do).

```bash
tools spotify analytics top artists --json | jq '.rows[:5] | .[] | {name, plays}'
tools spotify analytics compat me alice --json | jq '.components'
```

## Troubleshooting

- **The first run is slow.** It parses about 110 MB of export JSON and caches it; later runs
  load in about 40 ms. The cache key is the export files' size and mtime, which catches every
  ordinary change (a new export has another size, a re-download another mtime). It is not
  content-addressed: a same-size replacement written with a preserved mtime would reuse the
  old parse. Run `tools spotify cache-clear` if you ever doubt it. It removes only files
  named like its own caches, so a mistyped `SPOTIFY_CACHE_DIR` cannot take a data file with
  it.
- **`clock` or `calendar` is shifted by hours.** Timestamps in the export are UTC. Everything
  day- or hour-shaped converts to the profile's timezone first, so set it with `--tz` or
  `profile add <name> --tz <zone>`.
- **`profile add` says there is no `Streaming_History_Audio_*.json`.** The tool looks in the
  folder you named and one level below it. Point `--history` at the unzipped folder or the
  folder above it, not two levels up.
- **`profile add` fails with `ENOTDIR`.** You pointed `--history` at the zip. Unzip it first.
- **`build` fails on an old manual harvest.** Harvests saved through the old
  chrome-devtools-mcp path arrived wrapped in a ```` ```json ```` fence. `build` still strips
  it.
- **A harvest query starts failing.** Operation hashes rotate with every web-player release.
  Recover the whole catalogue from the live bundle:

  ```bash
  tools chrome-devtools eval \
      --file src/spotify/page/extractOperations.ts \
      --match open.spotify.com
  ```
- **Token sniffing returns nothing.** Hooking `window.fetch` does not work, because the app
  captured its own reference at load. Read the tab's network requests instead, which is what
  `harvest --auto` does.
- **A recommendation names no songs to try.** Run `tools spotify harvest --artists` first.
  It needs a harvested library, because every artist URI comes from Liked Songs.
- **`tools spotify ui` warns that the readiness check failed.** Check whether
  `SPOTIFY_UI_PORT` is set. See Configuration.

## Related

- [tools chrome-devtools](../chrome-devtools/README.md): the CDP library that `harvest --auto`
  and `play run` drive the browser with.
- [tools services](../services/README.md): starts the dashboard with the other GenesisTools
  servers.

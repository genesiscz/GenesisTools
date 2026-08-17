# `tools spotify` command reference

`tools spotify <command> [args] [options]`. From inside the repo checkout,
`bun run src/spotify/index.ts …` runs the same entry point.

## Options every analytics command accepts

| Flag | Meaning |
|---|---|
| `-p, --profile <name>` | whose data to read; defaults to the configured profile |
| `-s, --since <YYYY-MM-DD>` | plays on or after this **local** date |
| `-u, --until <YYYY-MM-DD>` | plays on or before this local date |
| `-y, --year <year>` | shorthand for a whole calendar year |
| `-n, --top <n>` | rows to print (default 20; does not change what is computed) |
| `--artist <name>` | restrict to artists whose name contains this, case-insensitive |
| `--genre <genre>` | restrict to one genre, resolved per play |
| `--platform <name>` | one device: `mac`, `ios`, `android`, `windows`, `linux`, `web`, `speaker` |
| `--min-ms <ms>` | the bar a play must clear (default 30000) |
| `--all-plays` | include everything, including 2-second skips |
| `--exclude-incognito` | drop private-session plays |
| `--tz <zone>` | IANA timezone for day and hour bucketing |
| `--json` | machine-readable output |

`--top` truncates the display only. `--csv` and `--out` always write the complete ranking, and
so does `--json`: it returns every row and records the requested number as `limit`. Asking for
20 forgotten tracks and piping `--json` onward hands the next step all 1,401 of them, with
nothing in the payload that looks like an error. Slice on `limit` yourself, or read the table.

`export` is the exception, because it has no full-output mode without `--out`: there `--top`
bounds the preview it prints, and `--out` still writes every row.

On `compat`, `blend` and `gift` the two people come from positional arguments, so `--profile`
is ignored there.

## Profiles

```bash
tools spotify profile list                  # also the default when you type just `profile`
tools spotify profile add <name> --history <dir> [--data <dir>] [--label "Name"] [--tz Europe/Prague]
tools spotify profile show [name]
tools spotify profile use <name>            # change the default
tools spotify profile rm <name>             # forgets the registration; deletes no files
```

`--history` accepts the zip's inner folder, the folder above it, or the folder holding the
JSON files directly. `--data` is the harvest output directory and is optional: a profile with
only a history export still supports every history-based command.

Registry lives at `~/.genesis-tools/spotify/profiles.json` (`SPOTIFY_CONFIG_PATH` overrides).
On first run it imports `~/.config/me-spotify/profiles.json` if the standalone skill left one
there, so an existing setup carries over untouched.

## Rankings

```bash
tools spotify analytics top [tracks|songs|artists|albums|genres]
    --by plays|hours    --min <n>    --csv <path>    --no-trend
```

`tracks` keys on the Spotify track id, so a song released on a single, an album and a
compilation appears three times. `songs` folds those together and adds a `rel` column with the
release count. Use `songs` for "my favourites" and `tracks` when the exact recording matters.

`genres` counts a play once per genre it carries, so shares sum above 100%. It prints the
share of plays that carried any genre at all; quote that number.

The `trend` column is a sparkline of that row's own activity across the window.

## Time

```bash
tools spotify analytics timeline  [-b day|week|month|quarter|year] [--by plays|hours]
tools spotify analytics clock                  # 7x24 heatmap, peak hour, night-owl and weekend shares
tools spotify analytics calendar               # one cell per day, one block per year
tools spotify analytics seasons                # month-of-year rhythm plus what each season sounds like
```

`timeline` picks a bucket that fits the window when you do not name one.

## Behaviour

```bash
tools spotify analytics summary                # the one-screen overview; alias: stats
tools spotify analytics behavior               # devices, shuffle, offline, private, start/end reasons
tools spotify analytics skips     [--min <starts>]
tools spotify analytics sessions  [--gap <minutes>]
tools spotify analytics streaks
```

A **skip** is a start that ended under 30 seconds or on the forward button. The export's own
`skipped` flag is null across most of the archive, so it is not the basis for the rate.

A **sitting** is plays separated by less than `--gap` minutes of silence (default 30).

## Biography

```bash
tools spotify analytics discovery                                   # novelty per year
tools spotify analytics firsts     [--min <plays>]                  # when each big artist arrived
tools spotify analytics forgotten  [--min <plays>] [--quiet-months <n>]
tools spotify analytics obsessions [--window <days>] [--min <plays>] # includes song-of-the-month
tools spotify analytics loyalty    [--min <plays>]                  # companions versus phases
```

`obsessions` finds each song's densest window, then reports the strongest one per month. That
second table is usually the most interesting output in the whole CLI.

## Composite views

```bash
tools spotify analytics dna                      # eight-axis taste fingerprint; alias: fingerprint
tools spotify analytics shift <from> <to> [--min <plays>]
```

`dna` axes are all ratios in `[0,1]`: diversity, concentration, novelty, obscurity, loyalty,
nocturnality, restlessness, repetition. Obscurity is log-scaled between 1k and 1B global
streams, since raw counts span six orders of magnitude.

`shift` runs the compatibility maths against the same person in two periods, so it reports
**continuity** (how much of the old taste survived) and its complement, **change**. Each
period is a year (`2019`) or a range (`2019-06-01:2019-12-31`). The "only in" tables list
artists present in one window and absent from the other; they are not first-ever discoveries,
which is what `firsts` is for.

## Library, where the two sources meet

```bash
tools spotify analytics audit                                   # liked-never-played, played-never-liked, dupes
tools spotify analytics gems  [--min <plays>] [--max-global <n>]
tools spotify analytics mainstream [--min <plays>]
tools spotify analytics saves                                   # library growth over time
```

These need a harvested library. `gems` and `mainstream` are the only commands that combine
personal plays with global stream counts, and both label which is which.

## Deep dives

```bash
tools spotify analytics artist "<name>"
tools spotify analytics track  "<title>"
tools spotify analytics search "<anything>"
tools spotify analytics wrapped [year]
```

## Two people

```bash
tools spotify analytics compat <a> <b> [--timeline] [-b month|quarter|year] [--min-plays <n>]
tools spotify analytics blend  <a> <b> [--min <plays each>]
tools spotify analytics gift   <from> <to>
```

See `compatibility.md` for what the score means.

## Data pipeline

```bash
tools spotify doctor                    # what exists, what is missing, the next command
tools spotify harvest                   # prints the browser sequence; not automatable headlessly
tools spotify build   [-p <profile>]
tools spotify enrich  [musicbrainz|lastfm|both] [-p <profile>] [--key <lastfm key>]
tools spotify genres-merge [-p <profile>] [--since <date>] [--min <n>] [--top <n>]
tools spotify history-merge [-p <profile>] [--history <dir>] [--by tracks|artists|genres]
tools spotify export  [tracks|songs|artists|library] [--out <path>] [--format csv|jsonl|json]
tools spotify cache-clear
```

`export` without `--out` prints a preview instead of writing.

`history-merge` joins personal plays onto the liked-track library and writes
`spotify_library.full.jsonl`. It is the only thing that puts both numbers on one row.

## Playback

Hear tracks instead of reading about them: `play run` drives the web player's own internal
player (`playerAPI`) in the user's logged-in browser over CDP — no DOM clicking, and the
track does not have to be in Liked Songs. Needs the browser running with remote debugging
(default endpoint `http://127.0.0.1:9222`) and an open `open.spotify.com` tab, or it opens one.

```bash
tools spotify play plan                       # show the plan; any flag below updates it
tools spotify play plan --windows 10:3,20:3,30:3 --tracks <file> [--queue|--no-queue] [--between <ms>]
tools spotify play run   [--resume | --restart] [--start <i>] [--end <i>] [--browser-url <url>]
tools spotify play status                     # done / failed / where to resume
tools spotify play harvest                    # same library-download guide as `tools spotify harvest`
```

A window is `start:duration` in seconds — `40:30` means "seek to 0:40, listen for 30s".
The tracks file is `[{uri, name?, artists?, windows?}]` or `{all: [...]}`; a track's own
`windows` array overrides the plan's ("play THIS song for 30 seconds starting at 0:40").
Progress is journalled per tracks file under `~/.genesis-tools/spotify/play/`, so `--resume`
skips what already played; `run` flags default from the plan.

## The dashboard

```bash
tools spotify ui                 # http://localhost:3075, opens a browser
tools spotify ui status|down|logs|restart
```

Every **report** page is the same report the CLI prints, over HTTP at `/api/report/<name>`
with the flags as query parameters — `/api/report/top?kind=artists&year=2025` answers what
`tools spotify analytics top artists --year 2025 --json` prints. The profile and the window
are chosen in the header and apply to every report page.

The dashboard also has pages that are not CLI reports: **Settings** edits the profile
registry (the same state `tools spotify profile add/use/rm` writes) through
`/api/profiles`, and is the one place the UI mutates anything.

## Environment

| Variable | Effect |
|---|---|
| `SPOTIFY_PROFILE` | default profile without passing `-p` |
| `SPOTIFY_EXPORT_DIR` | where a first run looks for `streaming-history/` and `data/` before falling back to `~/Documents/Spotify` |
| `SPOTIFY_CONFIG_PATH` | path to the profile registry |
| `SPOTIFY_CACHE_DIR` | path to the parsed-history cache |
| `SPOTIFY_UI_PORT` | dashboard port (default 3075) |
| `SPOTIFY_BROWSER_URL` | CDP endpoint `play run` attaches to (default `http://127.0.0.1:9222`) |
| `LASTFM_API_KEY` | use the Last.fm API instead of scraping the tag page |
| `NO_COLOR` | disable colour even on a terminal |

## JSON output

Every analytics command supports `--json` and emits an object with the profile, the window,
and the rows. Sets are serialised as arrays. This is the right way to feed results into
another script rather than re-parsing the table.

```bash
tools spotify analytics top artists --json | jq '.rows[:5] | .[] | {name, plays}'
tools spotify analytics compat me kaja --json | jq '.components'
```

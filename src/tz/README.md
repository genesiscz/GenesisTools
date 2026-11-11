# tools tz

> **Convert a time across timezones from natural language.**

You know the meeting is at 3pm Pacific. You need it in Prague. `tools tz '3pm America/Los_Angeles in Prague'` does that in one line,
without opening a converter site. One call can also fan a single moment out across a whole team's zones.

`tools tz` comes with GenesisTools (`bun install && ./install.sh` puts `tools` on your PATH). It needs only Bun: no
account, no network, and no data or config of its own (only the shared logs, see How it works).

## Quick start

```bash
tools tz '3pm America/Los_Angeles in Prague'        # one time, one target zone (follows summer time)
tools tz 9am CET in New York                        # quoting is optional
tools tz 'tomorrow 08:30 in Tokyo'                  # 08:30 tomorrow on your clock, shown in Tokyo
tools tz now                                        # now, in your zone and five common zones
tools tz now --to America/New_York,Asia/Tokyo,UTC   # now, in the zones you list
tools tz '3pm America/Los_Angeles in Prague' --json # the same answer as a JSON array
```

## Command and options

`tz` is one command with no subcommands.

```text
tools tz [options] <expr...>
```

| Argument or option | What it does                                     |
|--------------------|--------------------------------------------------|
| `<expr...>`        | The time and zone text. Quoting is optional.     |
| `--to <zones>`     | Comma-separated target zones (aliases or IANA).  |
| `--json`           | A JSON array on stdout, one object per zone.     |
| `-v, --verbose`    | Print debug lines on stderr.                     |
| `--readme`         | Print this README and exit.                      |
| `-h, --help`       | Print the usage.                                 |

The words of `<expr...>` are joined with spaces, and a comma counts as a space. Quote the text when it holds a
character your shell reads itself, such as `?`, `*` or `(`. `--to` replaces any `in <zone>` in the text.

## Write the expression

An expression has up to three parts, in this order: a time, an optional source zone, and an optional target zone.

```text
2026-06-02 09:00    Europe/Prague    to America/New_York
<time>              <source zone>    <target zone>
```

### The time

The chrono-node library reads the time, in English, relative to the moment you run the command.

- A clock time: `3pm`, `15:00`, `08:30`, `noon`, `midnight`.
- A day with a clock time: `tomorrow 08:30`, `friday 14:00`, `2026-06-02 09:00`.
- A moment relative to now: `now`, `in 2 hours`, `in 30 minutes`. These give the exact instant.

A time with no clock hour means 00:00 of that day. This covers a day on its own (`tomorrow`, `friday`, `2026-06-02`,
`in 3 days`) and the soft words `morning`, `afternoon`, `evening` and `tonight`: chrono-node only guesses an hour for
them, and the tool uses only an hour you wrote. So `tomorrow morning in Tokyo` converts 00:00 tomorrow, not 06:00.
Write `tomorrow 9am in Tokyo` instead.

Exception: when an upper-case abbreviation follows the day (`tomorrow PST`, `friday CET`, `tonight ET`), chrono-node
treats the offset as certain and the day keeps its guessed hour: 06:00 for `morning`, 22:00 for `tonight`, 12:00 for
a weekday or a date, and the current hour for `tomorrow` or `in 3 days`. Write the hour: `tomorrow 9am PST`.

### The source zone

The source zone says which clock the time is read on. You give it in one of three ways:

- **An abbreviation right after the time**: `3pm PST`, `9am CET`, `14:00 JST`, in any letter case when the text has an hour. chrono-node
  reads it. After a day with no hour, write it in upper case (`friday CET`): chrono-node drops `friday cet` without a
  warning and the day is read on your own clock. Most abbreviations are fixed offsets, so `PST` is UTC-8 all year, also in summer. `PT`, `MT`, `CT`, `ET` and
  `CET` follow summer time.
- **An IANA name as the last word of the time**: `09:00 Europe/Prague`, `3pm America/Los_Angeles`. It follows summer
  time for the date you give.
- **Nothing**: the time is read on the clock of the machine that runs the command (its system zone). `TZ` changes
  that for one run, as for any Bun program: `TZ=Asia/Tokyo tools tz 9am`.

A city name is not a source zone. `9am Prague in Tokyo` reads 9am on your own clock and ignores `Prague`. Write
`9am CET in Tokyo` or `9am Europe/Prague in Tokyo`.

### The target zone

- **`in <zone>` or `to <zone>`** at the end of the text: `3pm PST in Prague`, `09:00 Europe/Prague to America/New_York`.
- **`--to <zones>`**: a comma-separated list, one row per zone, in your order. It wins over an `in <zone>` in the
  text. Quote a name with a space: `--to 'New York,Tokyo'`.
- **Neither**: your local zone, labelled `Local (<zone>)`, then `UTC`, `America/New_York`, `Europe/London`,
  `Europe/Prague` and `Asia/Tokyo`. The list is fixed in `src/tz/lib/convert.ts` (`DEFAULT_ZONES`); there is no setting
  for it. When your zone is in the list, it shows twice. To keep a list of your own, put `--to` in a shell alias.

A target is an IANA name (any letter case, for example `Asia/Tokyo`) or one of these aliases (any letter case):

- Abbreviations: `PST` and `PDT` (America/Los_Angeles), `MST` and `MDT` (America/Denver), `CST` and `CDT`
  (America/Chicago), `EST` and `EDT` (America/New_York), `GMT` (Etc/GMT), `BST` (Europe/London), `CET` and `CEST`
  (Europe/Prague), `EET` (Europe/Athens), `UTC`.
- Cities: `Prague`, `London`, `Paris`, `Berlin`, `New York` (also `NewYork` and `NYC`), `LA` (also `Los Angeles`),
  `Tokyo`, `Sydney`.

An abbreviation alias stands for a city's zone, so a target follows summer time: `in PST` in June shows `GMT-7`. A
row's label is the IANA name the alias stands for. Other abbreviations, such as `JST`, `IST` or `ET`, work as a source
but not as a target. Use the IANA name there: `in Asia/Tokyo`, `--to Asia/Kolkata`.

## Output

Run on 2 June 2026 on a Mac set to Europe/Prague (the first line of each example is the stderr header):

```text
$ tools tz '3pm PST in Prague'
3pm PST → Europe/Prague
  Europe/Prague           Wed, Jun 3, 2026   01:00  (GMT+2)

$ tools tz 3pm PST
3pm PST → default zones
  Local (Europe/Prague)   Wed, Jun 3, 2026   01:00  (GMT+2)
  UTC                     Tue, Jun 2, 2026   23:00  (GMT+0)
  America/New_York        Tue, Jun 2, 2026   19:00  (GMT-4)
  Europe/London           Wed, Jun 3, 2026   00:00  (GMT+1)
  Europe/Prague           Wed, Jun 3, 2026   01:00  (GMT+2)
  Asia/Tokyo              Wed, Jun 3, 2026   08:00  (GMT+9)
```

Each row shows the zone, the weekday and date, the time on a 24-hour clock, and the zone's UTC offset at that moment.
Above the rows, a header on stderr repeats the time text and the target, for example `3pm PST → Europe/Prague`. When
there is more than one row, the target in the header reads `default zones`, also for a `--to` list. The rows go to
stdout, so `tools tz now | pbcopy` copies the rows without the header.

`--json` is the scripting path. It prints one line of JSON on stdout and no header:

```json
[{"zone":"Europe/Prague","label":"Europe/Prague","weekday":"Wed","date":"Jun 3, 2026","time":"01:00","offset":"GMT+2","epochMs":1780441200000}]
```

| Field     | Meaning                                              |
|-----------|------------------------------------------------------|
| `zone`    | The IANA zone of the row.                            |
| `label`   | `Local (<zone>)` for your zone in the default list, or `zone`. |
| `weekday` | Short English weekday, such as `Wed`.                |
| `date`    | Month, day and year, such as `Jun 3, 2026`.          |
| `time`    | `HH:MM` on a 24-hour clock.                          |
| `offset`  | The UTC offset then: `GMT+2`, `GMT-4`, `GMT+5:30`.   |
| `epochMs` | Instant in ms since 1970 UTC, the same in every row. |

The array pairs well with `tools json` for a compact view: `tools tz now --json | tools json`.

## How it works

- Nothing goes over the network. The tool has no config file, no data and no environment variable of its own. It
  needs no macOS permission and costs nothing. Like every GenesisTools command, it writes its log lines (the header
  and debug lines) to `~/.genesis-tools/logs/<date>.log`, and a failed run is recorded with its arguments, the
  expression included, in `~/.genesis-tools/logs/<date>-failures.jsonl`.
- `src/tz/lib/parse.ts` splits off the target and the source zone, then hands the rest to chrono-node. It then takes
  one of three paths: the exact instant when chrono-node is sure of the offset (an abbreviation, `now`, `in 2 hours`),
  00:00 of the day when no hour was written, or the written clock time on the source zone's clock.
- The shared helpers in `src/utils/timezone.ts` (`@genesiscz/utils/timezone`) hold the target alias list and turn a
  wall-clock time into an instant with the zone's summer-time offset for that date. Bun's `Intl` renders every row,
  with English month and weekday names whatever the system language.

## For agents

- Use `--json` and read `epochMs`, or `time` with `offset`.
- Exit code 0 means success. Exit code 1 means no time could be read (`Could not parse a time from: "<text>"`) or a
  `--to` zone is unknown (`Unknown timezone: "<zone>"`). The message goes to stderr. A usage error (no expression, an
  unknown option) also exits 1, and the help follows the error.
- Prefer `--to` over `in <zone>`. An unknown zone in `--to` fails with exit code 1. An unknown zone after `in` falls
  back to the default list and still exits 0.
- Always give a source zone. Without one, the time is read on the clock of the machine that runs the command.

## Troubleshooting

**The default list shows, although the text ends in `in <zone>`.** The target reader does not know that zone
(`in JST`, `in Mumbai`, a misspelling), so the words stayed in the time text. An earlier ` in ` or ` to ` can also take
the match: in `noon in 3 days in Tokyo`, the tool tries `3 days in Tokyo` as the zone. Use an IANA name
(`in Asia/Tokyo`) or `--to Asia/Tokyo`, which fails loudly on a bad name. With `-v`, a debug line says when a trailing
`in` or `to` is not a zone.

**A city as the source zone changes nothing.** `9am Prague in Tokyo` reads 9am on your own clock. Give the source as
an abbreviation (`9am CET`) or an IANA name (`9am Europe/Prague`).

**`3pm PST` in summer is one hour off the Pacific clock.** `PST` is UTC-8 all year, and the Pacific clock is on UTC-7
in summer. Write `3pm PT` or `3pm America/Los_Angeles`.

**`tomorrow morning` converts 00:00.** Only a written hour counts. Write `tomorrow 9am`. With an upper-case
abbreviation after the day (`tomorrow morning PST`), the guessed hour is kept instead (06:00), so write the hour there
too. A lower-case zone after a day (`friday cet`) changes nothing: write it in upper case.

**`Could not parse a time from: "<text>"`.** chrono-node found no time in the text. It reads English only. A zone on
its own is not a time: write `now in Tokyo`, not `Tokyo`.

**`Unknown timezone: "<zone>"`.** A `--to` entry is neither an alias nor an IANA name. `JST`, `IST` and `AEST` are
among these: use `Asia/Tokyo`, `Asia/Kolkata` and `Australia/Sydney`.

## Related

- [`tools json`](../json/README.md): turns the `--json` array into a compact table.

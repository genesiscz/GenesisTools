# tools tz

> **Convert a time across timezones from natural language.**

You know the meeting is at 3pm Pacific. You need it in Prague. This does that in one line, without opening a converter site.

---

## Quick start

```bash
tools tz '3pm PST in Prague'
tools tz 9am CET in New York          # quoting is optional
tools tz 'tomorrow 08:30 in Tokyo'
tools tz 'now' --to America/New_York,Asia/Tokyo,UTC
tools tz '3pm PST in Prague' --json
```

## Arguments and options

| Item | Description |
|------|-------------|
| `<expr...>` | The natural-language time and zone expression. Quoting is optional. |
| `--to <zones>` | Comma-separated target zones. Accepts aliases or IANA names. |
| `--json` | Emit a structured JSON array on stdout |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## How the expression is parsed

The expression is parsed as a time plus an optional source zone plus an optional target. Relative words work (`now`, `tomorrow`, `in 2 hours`), as do bare clock times (`3pm`, `15:00`, `08:30`). Zone names accept both common abbreviations (`PST`, `CET`, `JST`) and full IANA identifiers (`America/Los_Angeles`, `Europe/Prague`).

When you pass `--to`, the expression supplies the source and `--to` supplies every target, so one call can fan a single moment out across a whole team.

`--json` is the scripting path. It prints an array, one entry per target zone, which pairs well with `tools json` for a compact view.

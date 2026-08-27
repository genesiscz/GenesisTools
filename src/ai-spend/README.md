# tools ai-spend

> **Claude Code token and cost analytics across all local sessions.**

Reads the session records Claude Code leaves on disk and turns them into a spend report: what the window cost, which sessions were expensive, and what today looks like so far.

Also reachable as `tools claude spending`, which is an alias for this tool.

---

## Commands

| Command | Description |
|---------|-------------|
| `summary` | Spend summary for the window (default) |
| `sessions` | Most expensive sessions leaderboard |
| `today` | Today's spend, by UTC day |
| `monitor` | Today + current week (LOCAL timezone, Monday week start) in well under 1s — for status bars. `--json` emits `{today, week, todayDate, weekStart, timezone}` |

## Quick start

```bash
tools ai-spend                                  # 30-day summary
tools ai-spend --since 7d
tools ai-spend --since 2026-08-01
tools ai-spend sessions --top 20
tools ai-spend today
tools ai-spend --model opus                     # only models matching "opus"
tools ai-spend --project GenesisTools           # only this project
tools ai-spend --json | tools json
```

## Options

Every option applies to every subcommand.

| Flag | Description |
|------|-------------|
| `--since <when>` | Include events on or after `Nd` or `YYYY-MM-DD` (default: `30d`) |
| `--model <substr>` | Filter to models containing this substring |
| `--project <substr>` | Filter to projects (by cwd) containing this substring |
| `--top <n>` | Leaderboard length (default: 10) |
| `--json` | Emit the report as JSON to stdout |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## Reading the numbers

`--project` matches on the session's working directory, which is how per-repo attribution works without any tagging on your part. `--model` is a substring match, so `--model opus` covers every Opus variant in the window.

`today` uses the **UTC day**, not your local one. That matters near midnight in a non-UTC timezone: a session that feels like tonight may land in tomorrow's bucket. Use `--since` with an explicit date when the boundary matters.

`monitor` is the exception: it uses **local midnight** and a **Monday-start local week**, and it is built for sub-second polling. It prunes transcripts by mtime (a file untouched since the week start is never opened), keeps an incremental per-file cache (unchanged files are never re-read; grown files parse only the appended tail), and does a full tree re-walk at most every 10 minutes — between sweeps, a brand-new transcript in a previously-quiet deep directory shows up on the next sweep. Pricing is the same static Anthropic catalog as the rest of this tool — **no LiteLLM, no ccusage, no network** — so a model missing from the catalog costs $0 rather than a guessed rate.

`--json` is the stable interface for dashboards and scripts. The table layout is for humans.

## Notes

- This reports on Claude Code sessions specifically. For token and cost analytics of the `ask` tool, use [`tools usage`](../usage/README.md).
- Costs are derived from recorded token counts and model rates. A number here is an estimate of what was consumed, not an invoice fetched from a billing API.
- `tools claude usage` is a different thing: an interactive TUI showing API usage and account limits. This tool is the historical spend view.

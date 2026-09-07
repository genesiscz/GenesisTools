# tools ai-spend

> **Coding-agent token and cost analytics across all local sessions.**

Reads the session records your coding agents leave on disk and turns them into a spend report: what the window cost, which sessions were expensive, and what today looks like so far.

`summary`, `sessions` and `today` read Claude Code only. `monitor` reads Claude Code, Codex and Grok, and reports each one separately.

`daily`, `weekly`, `monthly`, `session`, `blocks` and `statusline` mirror the live `ccusage` command tree (unified across every detected source, plus per-source namespaces). `--json` uses the same grouping keys and token field names as `ccusage --json`.

Also reachable as `tools claude spending`, which is an alias for this tool.

---

## Commands

| Command | Description |
|---------|-------------|
| `summary` | Spend summary for the window (default) |
| `sessions` | Most expensive sessions leaderboard |
| `today` | Today's spend, by UTC day |
| `monitor` | Today + current week (LOCAL timezone, Monday week start) across Claude Code, Codex and Grok in well under 1s — for status bars. `--json` emits `{today, week, todayDate, weekStart, timezone, agents}` |
| `series` | Transcript spend over time, bucketed and split by account. `--grain hour\|day\|week`, `--from`, `--to`, `--account`, `--sources`, `--by-model`, `--json` |
| `daily` / `weekly` / `monthly` | All detected sources grouped by period (ccusage-compatible JSON) |
| `session` | All detected sources grouped by session |
| `blocks` | Claude Code 5-hour billing windows (`--active`, `--recent`) |
| `statusline` | Compact Claude Code hook line (reads hook JSON from stdin) |
| `<source> daily\|monthly\|session` | One source only (`claude` also has `weekly`, `blocks`, `statusline`; `opencode` also has `weekly`) |

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

`monitor` is the exception: it uses **local midnight** and a **Monday-start local week**, and it is built for sub-second polling. It prunes transcripts by mtime (a file untouched since the week start is never opened), keeps an incremental per-file cache (unchanged files are never re-read; grown files parse only the appended tail), and does a full tree re-walk at most every 10 minutes — between sweeps, a brand-new transcript in a previously-quiet deep directory shows up on the next sweep. Pricing is the same static catalog as the rest of this tool — **no LiteLLM, no ccusage, no network** — so a model missing from the catalog costs $0 rather than a guessed rate.

`--json` is the stable interface for dashboards and scripts. The table layout is for humans.

---

## `monitor` drivers

Each agent contributes a driver under `lib/drivers/`. A driver declares only three things: which directories to walk, which file names are transcripts, and how one JSONL line becomes a usage event. The walker, the mtime pruning, the incremental tail cache and the 10-minute sweep are shared, so an agent is added by adding a folder, not by forking the scanner.

| Agent | Files | Usage line | Cost |
|---|---|---|---|
| `claude` | `~/.claude/projects/**/*.jsonl`, `~/.config/claude/projects/**`, `$CLAUDE_CONFIG_DIR/projects/**` | `type: "assistant"` with `message.usage` | catalog rates for `anthropic` |
| `codex` | `~/.codex/{sessions,archived_sessions}/**/*.jsonl`, or every `$CODEX_HOME` in the comma-separated list | `type: "event_msg"` with `payload.type: "token_count"`; the model comes from the preceding `turn_context` line | catalog rates for `openai` |
| `grok` | `~/.grok/sessions/**/updates.jsonl`, or under `$GROK_HOME` | `params.update.sessionUpdate: "turn_completed"`, one event per entry in `usage.modelUsage` | the `costUsdTicks` Grok recorded (1 tick = 1e-10 USD) |

Line shapes and token arithmetic mirror ccusage's Rust adapters, so the numbers line up with what ccusage reports for the same files:

- **Codex.** `last_token_usage` is the per-turn figure, but it is only counted when `total_token_usage` ADVANCED since the previous line — Codex re-emits an unchanged total on some events, and counting `last` again would double-bill the turn. With no `last_token_usage` at all, the difference of the cumulative totals is used instead. `cached_input_tokens` is a subset of `input_tokens`, so billable input is `input − cached`. `reasoning_output_tokens` sits inside `output_tokens` and is never billed on top.
- **Grok.** `cachedReadTokens` and `cacheCreationTokens` are subsets of `inputTokens`, so the three parts sum back to `inputTokens`. `reasoningTokens` sits inside `outputTokens`. The recorded `costUsdTicks` is authoritative: Grok prices each API request separately and a `turn_completed` row carries only the per-turn sum, so recomputing from those totals cannot reproduce the figure Grok actually billed.
- **Claude.** Anthropic reports `input_tokens` already net of cache, so its four token fields are disjoint and nothing is subtracted.

**Unpriced models cost $0.** The catalog carries rates for `anthropic` and `openai` only. Codex's plan and task variants are peeled down to a catalog id one suffix at a time (`gpt-5.3-codex-spark` → `gpt-5.3-codex` → `gpt-5.3`, `gpt-5.6-sol` → `gpt-5.6`), and `grok-4.6-build` peels to `grok-4.6`. An id that still matches nothing — `codex-auto-review`, every `xai` id — contributes $0 rather than a guessed family rate. Grok is unaffected in practice because it reports its own cost.

`--json` gains an `agents` object and keeps the existing top level, which is the sum across agents:

```json
{
  "today": { "cost": 404.96, "tokens": 358954522 },
  "week": { "cost": 2612.44, "tokens": 3254443009 },
  "todayDate": "2026-08-27",
  "weekStart": "2026-08-24",
  "timezone": "Europe/Prague",
  "agents": {
    "claude": { "today": { "cost": 404.36, "tokens": 355450116 }, "week": { "cost": 2550.61, "tokens": 2872579230 } },
    "codex":  { "today": { "cost": 0, "tokens": 0 },              "week": { "cost": 0.50, "tokens": 429041 } },
    "grok":   { "today": { "cost": 0.61, "tokens": 3504406 },     "week": { "cost": 61.34, "tokens": 381434738 } }
  }
}
```

Measured on this machine (11.5k Claude transcripts, 207 Codex rollouts, 2.9k Grok sessions): a warm run is **0.08–0.11s** wall clock, and the 10-minute full sweep costs about **200–270ms** on top.

## Notes

- `series` answers "how did spend move over time" for the dashboard. Buckets are LOCAL, and its per-file event cache (`~/.genesis-tools/ai-spend/cache/events-cache.json`, rolling 90 days) means an unchanged transcript is never re-parsed. Claude transcripts carry no account marker, so they report as one `claude (all accounts)` row; transcripts under a home no account claims report as `(unbound)`. Per-account Claude numbers come from the call log instead (`queryUsage({ grain })`).
- `summary`, `sessions` and `today` report on Claude Code sessions specifically; only `monitor` reads Codex and Grok as well. For token and cost analytics of the `ask` tool, use [`tools usage`](../usage/README.md).
- Costs are derived from recorded token counts and model rates. A number here is an estimate of what was consumed, not an invoice fetched from a billing API.
- `tools claude usage` is a different thing: an interactive TUI showing API usage and account limits. This tool is the historical spend view.

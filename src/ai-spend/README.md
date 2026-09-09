# tools ai-spend

Also available as `tools ai-usage`.

## Codex pricing and review passes

```bash
tools ai-usage codex daily --since 2026-09-07 --breakdown
tools ai-usage codex reviews --since 2026-09-07 --timezone Europe/Prague
tools ai-usage codex reviews --since 2026-09-07 --json
tools ai-usage codex session --id rollout-example --json
```

The existing `--account <id...>`, `--all-homes`, date and timezone filters apply.
`CODEX_HOME` can select a specific home when no configured account claims the roots.
The alias uses the same `ai-spend` configuration and storage.

Codex daily/monthly/session reports now include an `analysis` object with model costs,
activity totals, review passes, long-context counts and pricing coverage.
`codex reviews` returns that analysis directly. Costs are API-equivalent estimates,
not booked subscription charges.

Astra pricing comes from the shared catalog, verified against
[OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) and
[Astra's model page](https://developers.openai.com/api/docs/models/gpt-6-astra) on 2026-09-07:

| USD per million tokens | Input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Standard, input at most 272,000 | 10 | 1 | 12.50 | 50 |
| Standard, input above 272,000 | 20 | 2 | 25 | 75 |
| Fast, input at most 272,000 | 20 | 2 | 25 | 100 |
| Fast, input above 272,000 | 40 | 4 | 50 | 150 |

Each request is priced **before** grouping. Input length includes cached input and
cache writes; output does not determine the band. Above the boundary, the higher
rates apply to the entire request, not just excess tokens. Cached tokens are
subtracted from ordinary input, and reasoning tokens are already part of output.
For example, 2,001 ordinary input + 270,000 cache-read + 1,000 output costs
$0.65502 at standard speed. Exactly 272,000 input stays in the short band.

The exact `gpt-5.6-sol` model also has its published rates: $4/$0.40/$5/$20
for ordinary input/cache-read/cache-write/output, doubled input/cache and 1.5x
output above 272K, with Fast doubling both bands. This is the promotion OpenAI
says is available at least through 2026-11-21; no unannounced post-promotion price
is invented.

`gpt-5.6-terra` and `gpt-5.6-luna` carry their own published rates too, verified
2026-09-08 against `developers.openai.com`. Terra is $2/$0.20/$2.50/$12 for
ordinary input/cache-read/cache-write/output; Luna is $0.20/$0.02/$0.25/$1.20.
Both follow the same two-axis shape as Sol: doubled input and cache with 1.5x
output above 272K, and Fast doubling whichever band applies. They are separate
catalog entries rather than aliases of `gpt-5.6`, which is why the suffix ladder
below no longer peels them.

Tier changes are read from `thread_settings_applied.thread_settings` and explicit
`turn_context` fields, and survive incremental parser resumes.
Recorded `service_tier: priority` and `fast` select Fast rates. Missing tiers use
standard rates and appear in `unspecifiedTierRequests`; today's configuration is
never used to guess yesterday's tier. Region-specific billing is not inferred.
Custom pricing overrides retain catalog context rules unless `rules: []` explicitly
clears them. Monitor and series caches are invalidated for the new parser/pricing.

Review attribution has explicit evidence:
- `metadata`: Codex's native review-mode events, or a permission-review model/guardian.
- `completion-text`: a dedicated review subagent's completed report has code-review findings.
- `none`: insufficient evidence, including encrypted or missing completion text.

A reviewer name alone is not enough. Diagnostics in a reviewer session appear as
`other`; mixed implementation turns are not charged wholesale as code review.
The heuristic can miss reviews and is not a complete accounting of inline review work.
Pass totals include only usage within the selected window, even when the pass spans
midnight; `completed` describes the recorded task, not whether every request is in-window.
Request counts are distinct token-usage updates; cumulative-only logs cannot recover
individual calls that were never recorded.

Unknown models such as `codex-auto-review` retain their real names. Their cost is
`null`, never a guessed GPT-5.5 price. Codex row/model/total costs are also `null`
when incomplete; `knownCostUSD` is the priced subtotal. Terminal output says
`unknown`. This deliberately extends ccusage's JSON shape and differs from its
fallback-price behavior. Older non-Codex reports retain their existing shapes.

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

**Unpriced models cost $0.** The catalog carries rates for `anthropic` and `openai` only. Codex's TASK variants are peeled down to a catalog id one suffix at a time (`gpt-5.3-codex-spark` → `gpt-5.3-codex` → `gpt-5.3`), and `grok-4.6-build` peels to `grok-4.6`. The plan variants `-sol`, `-terra` and `-luna` are **not** peeled: each carries its own rates in the catalog, and folding them onto `gpt-5.6` ($5/$30) would bill Luna ($0.20/$1.20) at twenty-five times its price. An id that still matches nothing — `codex-auto-review`, every `xai` id — contributes $0 rather than a guessed family rate. Grok is unaffected in practice because it reports its own cost.

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

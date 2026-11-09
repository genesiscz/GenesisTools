# tools ai-spend

Token and cost analytics for the coding agents on this Mac. It reads the session files that Claude Code, Codex, Grok
and the other agents `ccusage` knows leave on disk, prices every request at the model's list rate, and reports what a
window cost, which sessions were expensive, and where the money went.

Use it to see the API-equivalent cost behind a subscription, to feed a status bar, to get `ccusage`-compatible JSON
without installing ccusage, or to find avoidable spend. Every figure is an estimate from recorded token counts and
catalog rates. It is never an invoice fetched from a billing API.

## Quick start

```bash
tools ai-spend                               # 30-day summary: totals, trend, by model, top projects and sessions
tools ai-spend sessions --since 7d --top 20  # the 20 most expensive sessions of the last 7 days
tools ai-spend daily --since 7d --breakdown  # ccusage-style daily table across every agent, per model
tools ai-spend monitor                       # today, yesterday, this week and the last 7 days in under a second
tools ai-spend codex reviews --since 7d      # Codex spend split into coding and code review passes
tools ai-spend workers --since 7d            # what the headless Codex, Grok and Claude workers cost
```

## Commands

The commands fall into six groups. `tools ai-spend --help` and `tools ai-spend <command> --help` list the same set.

| Group | Commands |
| --- | --- |
| Spend summary | `summary` (the default), `sessions`, `today` |
| ccusage reports | `daily`, `weekly`, `monthly`, `session`, `blocks`, `statusline`, `<source> <report>` |
| Over time and by dimension | `series`, `pivot`, `waste` |
| Status bars | `monitor` |
| Subscriptions and the proxy | `plans`, `plans price`, `proxy` |
| Headless workers | `workers` |

`-v, --verbose` turns on verbose logging and `--readme` prints this file. Both work on every command.

### Spend summary: `summary`, `sessions`, `today`

`tools ai-spend` with no command runs `summary`.

- `summary`: the window's spend, tokens (input, output, cache write, cache read) and cache-hit rate, a daily trend
  chart, then tables by model, top projects and top sessions.
- `sessions`: the most expensive sessions in the window.
- `today`: today's spend, tokens and cache-hit rate.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--since <when>` | `30d` | `Nd` or `YYYY-MM-DD`, as a UTC day |
| `--model <substr>` | | Only models whose id contains this |
| `--project <substr>` | | Only projects (by working directory) containing this |
| `--top <n>` | `10` | Leaderboard length |
| `--harness [ids]` | all | Comma list of sources; `--sources <ids>` is the older name |
| `--json` | | Print the report as JSON |

```bash
tools ai-spend --since 2026-08-01            # from a fixed UTC day
tools ai-spend --model opus                  # every Opus variant in the window
tools ai-spend --project app --json          # one repository, as JSON
tools ai-spend --harness claude,codex        # two agents only
```

- `--project` matches the session's working directory, so per-repository attribution needs no tagging.
- `--model` is a substring match, so `--model opus` covers every Opus variant.
- `today` uses the **UTC day**, not the local one, and ignores `--since`. Near midnight in a non-UTC zone, a session
  that feels like tonight can land in tomorrow's bucket. When the boundary matters, use `summary --since <date>`, a
  ccusage report with `--timezone`, or `monitor`, which uses local midnight.
- The source ids are `claude`, `codex`, `opencode`, `amp`, `droid`, `codebuff`, `hermes`, `pi`, `goose`, `kilo`,
  `copilot`, `gemini`, `kimi`, `qwen`, `openclaw`, `grok` and `jev`. The default reads all of them. These three
  commands used to read Claude Code only; `--harness claude` gives that view back.

### ccusage-compatible reports

`daily`, `weekly`, `monthly`, `session`, `blocks` and `statusline` mirror the `ccusage` command tree. The top-level
commands are unified across every detected source. `--json` uses the same grouping keys and token field names as
`ccusage --json` (`lib/reports/parity.test.ts` compares the JSON).

- `daily`, `weekly`, `monthly`: usage grouped by period.
- `session`: usage grouped by session.
- `blocks`: usage grouped by 5-hour Claude Code billing windows (Claude data only).
- `statusline`: one compact line for Claude Code's status bar. It reads the hook JSON on stdin.

| Flag | Commands | Meaning |
| --- | --- | --- |
| `-j, --json` | all but `statusline` | Print the report as JSON |
| `-s, --since <since>` | all but `statusline` | `YYYY-MM-DD`, `YYYYMMDD` or `Nd` |
| `-u, --until <until>` | all but `statusline` | Last day, inclusive |
| `-z, --timezone <tz>` | all | IANA zone for day grouping (default: the system zone) |
| `--last <n>` | period reports | Only the most recent N periods |
| `-b, --breakdown` | all but `statusline` | A cost row per model |
| `-i, --id <id>` | `session`, `codex reviews` | One session |
| `-m, --mode [mode]` | `blocks`, `statusline`, every `claude` report | `auto`, `calculate` or `display` |
| `-a, --active` | `blocks` | Only the active block, with projections |
| `-r, --recent` | `blocks` | Blocks of the last 3 days, the active one included |
| `-n, --session-length [h]` | `blocks` | Block length in hours (default `5`) |
| `-B, --visual-burn-rate [v]` | `statusline` | `off`, `emoji`, `text` or `emoji-text` |
| `--by-agent` | all but `statusline` | Per-agent JSON breakdowns in unified rows |
| `--all-homes` | all but `statusline` | Also read provider homes no account is bound to |
| `--account <id...>` | all but `statusline` | Only these account ids (see [Accounts](#accounts)) |

The tool-wide `--harness [ids]` (or `--sources`) also narrows these reports.

- **Without `--since`, a report reads every transcript on disk**, as ccusage does. The tool's `30d` default applies to
  `summary`, `sessions` and `workers`, not to the ccusage reports. With `--since`, a transcript last written more than
  3 days before the start is never opened.
- `--id` takes a leading part of a session id. The part resolves through the history index, so only that session's
  files are read. An ambiguous part is refused with the candidates. A Codex thread id becomes the rollout name that
  Codex usage is keyed by (`rollout-<time>-<thread id>`). An id that nothing matches prints a warning, and every
  total is zero.
- `--mode auto` takes a recorded list price when the agent wrote one and the catalog price otherwise. `calculate`
  always uses the catalog. `display` shows only what the agent recorded. Only Claude Code records its own cost, so
  only the Claude reports (and the unified `blocks` and `statusline`) take `--mode`.

#### One source only: `<source> <report>`

```bash
tools ai-spend codex daily --since 7d
tools ai-spend grok session --since 2026-11-01 --json
tools ai-spend jev session                   # Jev spend per feature label
```

Every source has `daily`, `monthly` and `session`. Some have more:

- `claude`: also `weekly`, `blocks`, `statusline`.
- `codex`: also `reviews`.
- `opencode`: also `weekly`.

A `--harness` list that leaves out the namespace's own source is refused, so a report is never printed unfiltered
under a filter.

#### Claude Code status line

`statusline` prints the model, the session cost, today's cost, the active block's cost with its time left, an
optional burn rate, and the context use. It reads only transcripts written in the last 2 days. To use it, point
Claude Code's settings at it:

```json
{ "statusLine": { "type": "command", "command": "tools ai-spend statusline" } }
```

### Codex review passes and pricing coverage

```bash
tools ai-spend codex daily --since 2026-09-07 --breakdown
tools ai-spend codex reviews --since 2026-09-07 --timezone Europe/Prague
tools ai-spend codex reviews --since 2026-09-07 --json
tools ai-spend codex session --id rollout-example --json
```

The `--account <id...>`, `--all-homes`, date and timezone filters apply. `CODEX_HOME` can select a specific home when
no configured account claims the roots.

`codex daily`, `codex monthly` and `codex session` add an `analysis` object to their JSON: model costs, activity
totals, review passes, long-context counts and pricing coverage. `codex reviews` returns that analysis directly. The
unified reports do not carry it. Costs are API-equivalent estimates, not booked subscription charges.

Review attribution has explicit evidence:

- `metadata`: Codex's native review-mode events, or a permission-review model or guardian.
- `completion-text`: a dedicated review subagent's completed report has code-review findings.
- `none`: insufficient evidence, including encrypted or missing completion text.

A reviewer name alone is not enough. Diagnostics in a reviewer session appear as `other`, and mixed implementation
turns are not charged wholesale as code review. The heuristic can miss reviews and is not a complete accounting of
inline review work. Pass totals include only usage within the selected window, even when the pass spans midnight;
`completed` describes the recorded task, not whether every request is in the window. Request counts are distinct
token-usage updates; cumulative-only logs cannot recover individual calls that were never recorded.

Unknown models such as `codex-auto-review` keep their real names. Their cost is `null`, never a guessed GPT-5.5
price. Codex row, model and total costs are also `null` when incomplete; `knownCostUSD` is the priced subtotal, and
terminal output says `unknown`. This deliberately extends ccusage's JSON shape and differs from its fallback-price
behavior. The reports of the other sources keep their existing shapes. The rates are in
[Codex and OpenAI rates](#codex-and-openai-rates).

### Over time and by dimension: `series`, `pivot`, `waste`

These three read Claude Code, Codex and Grok only (`--harness claude,codex,grok`), through a shared event cache that
keeps the last 90 days. A window that starts earlier gets nothing for the older part; use the ccusage reports
(`monthly --since ...`) for longer history.

#### `series`

Transcript spend over time, bucketed and split by account. The dashboard reads it to show how spend moved.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--from <when>` | 7 days ago | ISO instant or `YYYY-MM-DD` |
| `--to <when>` | now | ISO instant or `YYYY-MM-DD`, exclusive |
| `--grain [width]` | | `hour`, `day` or `week` |
| `--harness [ids]` | all three | `claude`, `codex`, `grok`; `--sources` is the older name |
| `--by-model` | | Also split each point by model |
| `--all-homes`, `--account <id...>` | | As on the reports |
| `--json` | | Print the series as JSON |

```bash
tools ai-spend series --grain day --from 2026-11-01 --json
```

- `--json` (and on `workers`, `--since`) is a tool-wide option, so `series --help` and `workers --help` do not list it.
- Pass `--grain` in scripts. Without it, a terminal gets a picker and a non-interactive run exits 1 with the list of
  values.
- Buckets are local time. A per-file event cache (rolling 90 days) means an unchanged transcript is never parsed again.
- Claude transcripts carry no account marker, so they report as one `claude (all accounts)` row. Transcripts under a
  home no account claims report as `(unbound)`. Per-account Claude numbers come from the call log instead
  (`queryUsage({ grain })`).
- Events with no known rate are counted on a last line: their cost is missing, not zero.

#### `pivot`

Transcript spend split by any mix of `provider`, `account`, `model`, `project`, `harness` and `session`, bucketed by
hour, day or week.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--by [dims]` | `provider` | Comma list of dimensions |
| `--grain [width]` | `hour` up to 7 days, `day` above | `hour`, `day` or `week` |
| `--heatmap` | | Add the hour-by-weekday heatmap of average dollars |
| `--since`, `--until`, `--tz` | `7d`, now, system zone | The [window grammar](#window-grammar-for-pivot-and-waste) |
| `--json` | | Print `usage.spend.pivot@1` |

```bash
tools ai-spend pivot --by provider,model --since 30d
tools ai-spend pivot --by project --grain day --heatmap
```

With `account` in `--by`, a warning says that Claude spend reaches an account only through its session's last pin.

#### `waste`

Avoidable spend: every cache rebuild after an idle gap, a compaction or a model change, priced as the context written
again at the cache-write rate instead of read at the cache-read rate. The kinds are `cache-rebuild-idle`,
`cache-rebuild-compaction`, `cache-rebuild-model` and `cache-rebuild-other`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--by [dims]` | `kind,account` | Comma list of `kind`, `provider`, `account`, `project`, `model`, `day`, `session` |
| `--top <n>` | `10` | How many of the costliest items to list, each with its session and a fix hint |
| `--since`, `--until`, `--tz` | `7d`, now, system zone | The [window grammar](#window-grammar-for-pivot-and-waste) |
| `--json` | | Print `usage.spend.waste@1` |

```bash
tools ai-spend waste --since 30d --by kind,project --top 5
```

The items are cached per transcript, so a weekly scan reads only the transcripts that changed. A transcript whose
harness cannot give a call trace is counted in a warning.

#### Window grammar for `pivot` and `waste`

`--since` and `--until` take a duration (`90m`, `6h`, `7d`, `4w`), a date `YYYY-MM-DD` (local midnight in `--tz`), an
ISO instant with an offset, or `today`, `yesterday`, `week` or `month`. `--tz` takes an IANA zone. Hidden aliases are
accepted too: `--from` and `--range` for `--since`, `--to` for `--until`, `--hours <n>` for `--since <n>h`, and
`--timezone` for `--tz`.

### Status bars: `monitor`

Today, yesterday, the current week (local time zone, Monday start) and the last 7 days across Claude Code, Codex and
Grok, built for sub-second polling.

| Flag | Meaning |
| --- | --- |
| `--json` | Print the four windows, their dates, the zone, `agents` and `accounts` (example below) |
| `--month` | Also the calendar month so far (local): adds `month` and `monthStart` |
| `--all-homes` | Also read provider homes on disk that no account is bound to |
| `--account <id...>` | Only these account ids |

```bash
tools ai-spend monitor
tools ai-spend monitor --json --month
```

`monitor` answers every agent at once, so `--harness` is refused: read `agents` in the JSON instead. `--month` comes
from the series event cache, which keeps 90 days and reads the same homes as the week, so the month never sums less
than the week inside it.

`--json` keeps the totals at the top level and splits them by agent. The values below are invented:

```json
{
  "today": { "cost": 41.20, "tokens": 35800000 },
  "yesterday": { "cost": 63.05, "tokens": 51200000 },
  "week": { "cost": 104.25, "tokens": 87000000 },
  "last7d": { "cost": 318.90, "tokens": 262000000 },
  "todayDate": "2026-11-10",
  "yesterdayDate": "2026-11-09",
  "weekStart": "2026-11-09",
  "last7dStart": "2026-11-04",
  "timezone": "Europe/Prague",
  "agents": {
    "claude": {
      "today": { "cost": 40.10, "tokens": 35000000 },
      "yesterday": { "...": "..." }, "week": { "...": "..." }, "last7d": { "...": "..." }
    },
    "codex": { "today": { "cost": 0.50, "tokens": 429000 }, "...": "..." },
    "grok": { "today": { "cost": 0.60, "tokens": 371000 }, "...": "..." }
  }
}
```

- `accounts` (one row per account, with the same four windows) appears only when accounts are configured or
  `--all-homes` or `--account` is given. A row that spent nothing in the last 7 days is left out.
- Strict contract: `today.cost`, `today.tokens`, `week.cost` and `week.tokens` are a strict contract: the Genesis app's spend reader
  decodes these four leaves and ignores every other key. They stay numbers at these exact paths; new keys may ride
  alongside, but cost never moves into a new top-level key.

How it stays fast:

- **mtime pruning.** Transcripts are append-only, so a file last written before the window start (local midnight six
  days ago, which always reaches back to the Monday) cannot hold an event inside it, and it is never opened.
- **An incremental per-file cache.** An unchanged file is never read again; a grown file is parsed only from its
  previous end. A Codex `.jsonl.zst` rollout never grows, so it is read whole once.
- **A full tree walk at most every 10 minutes.** Between sweeps, appends, new sibling transcripts and new project
  folders show up at once; a brand-new transcript in a previously quiet deep folder waits for the next sweep.
- Pricing is the same static catalog as the rest of this tool: **no LiteLLM, no ccusage, no network**. A model the
  catalog cannot price costs $0 rather than a guessed rate.

Measured on one machine (11.5k Claude transcripts, 207 Codex rollouts, 2.9k Grok sessions): a warm run is
**0.08 to 0.11 s** wall clock, and the 10-minute full sweep costs about **200 to 270 ms** on top.

### Subscriptions and the proxy: `plans`, `proxy`

#### `plans`

The value of each subscription account per billing cycle: the list-price spend of the sessions that ran on it, the
share of its weekly capacity used, the dollars per weekly point, and how many times the plan price was paid back.

| Flag | Meaning |
| --- | --- |
| `--provider [name...]` | Only these providers: an alias (`claude`, `codex`, `grok`) or a plugin id |
| `--json` | Print `usage.spend.plans@1` |

- The cycle is one calendar month back from the account's next renewal day. An account that names no renewal gets the
  last 30 days, shown as `(30 d)`.
- Capacity counts the rises of the weekly window this cycle, at 100 points per week.
- A Claude session reaches its account only through its pin. A session without a pin is never guessed; a pinned spend
  is marked `(pins)`, because a session that changed account counts for the last one.
- `PAID BACK` needs a plan price in USD. Without a price it says `no price`, and a warning names the command below.

#### `plans price <provider> <plan> <amount>`

Sets a plan's price per billing cycle. `--currency <code>` defaults to `USD`.

```bash
tools ai-spend plans price claude max 200
tools ai-spend plans price codex pro 229 --currency EUR
```

It writes `providers.<plugin id>.plans.<plan>` in the usage config (see [Configuration](#configuration)).

#### `proxy`

What the ai-proxy served: the booked cost per client and month, and the requests, rate limits, errors and cache-read
share per account and day.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--month <months...>` | every month in the ledger | Only these months, `YYYY-MM` |
| `--days <n>` | `14` | Days of per-account traffic: today and the 13 days before it |
| `--json` | | Print `usage.spend.proxy@1` |

The cost is the ledger's `cost_usd`, printed as stored and never recomputed. The proxy books cost when it writes the
row, so a later rate change never rewrites a past month.

### Headless workers: `workers`

The spend of the headless workers (`tools codex`, `tools grok`, `tools claude worker`) by backend, model, label, day,
name or outcome, with a Claude Opus and Sonnet estimate beside it.

```bash
tools ai-spend workers                              # last 30 days, by backend and model
tools ai-spend workers --since 7d --by label,day    # one row per spawn --label and day
tools ai-spend workers --by name --backend codex --json
tools ai-spend workers --backfill --dry-run         # what past turns would be booked
tools ai-spend workers --backfill                   # book them (read-only on the session files)
tools ai-spend workers --reprice --dry-run          # what today's rules would change
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--by [dims]` | `backend,model` | Comma list of `backend`, `model`, `label`, `day`, `name`, `outcome` |
| `--backend <list>` | all | `claude`, `codex`, `grok`; `--harness` is the newer name |
| `--label <substr>` | | Only sessions whose `spawn --label` contains this |
| `--since <when>` | `30d` | `Nd` or `YYYY-MM-DD` |
| `--until <day>` | | Last day included, `YYYY-MM-DD` |
| `--timezone <tz>` | this machine's | IANA zone for the day buckets |
| `--backfill` | | Book ledger rows for worker turns that ran before the ledger |
| `--reprice` | | Price every ledger row again from its turn files under today's rules (keeps a `.bak`) |
| `--dry-run` | | With `--backfill` or `--reprice`: show what would change, write nothing |
| `--json` | | Print the report, or the backfill or reprice summary, as JSON |

Every worker turn books one row in `~/.genesis-tools/workers/cost-ledger.jsonl`: backend, name, `spawn --label`,
turn, login (`subscription`, `api-key` or `unknown`), account name, duration, tool calls, outcome (`completed`,
`failed`, `interrupted`; a row without one groups as `unknown`) and the turn's price. The turn report and each
backend's `status --json` show the same line:
`cost: $0.69 API-equivalent (subscription, billed $0) · as Claude ≈ Opus $1.38 / Sonnet $0.69 (estimate)`.

- **API-EQ** is this tool's own price: each request at the worker model's list rate with its long-context band
  (`priceFor`, then `resolvePrice`, then `costOf`), exactly as the reports above price the same session. The figure a
  worker reported itself (Grok's plan metering, Claude Code's total) is shown beside it, and stands in only for a
  model without a list price, labelled `reported by <backend>`. The stats read the tokens and costs from the workers'
  transcripts through the same loaders, and take only the name, label, login, turns, duration and tool calls from the
  ledger. A session whose transcript is gone falls back to the price its turns booked.
- **BILLED** is $0 on a subscription login and the API-equivalent on an API key. `+?` means some amounts are unknown
  (no list price, or a login nobody recorded), not zero.
- **AS OPUS / AS SONNET** prices the same token profile at `claude-opus-5-5` and `claude-sonnet-5-5` from the same
  table. It is an estimate: Claude's tokenizer counts the same text differently, and a Claude agent would not take the
  same steps.
- **TURNS and TIME** come from the ledger, so a session from before it shows 0 until `--backfill`.
- Worker homes outside the default roots (`--worker-home`, `worker-home-noskills`, a codex `--home`) are read, because
  the worker's own session record names its home.
- `--backfill` and `--reprice` work on the whole ledger and refuse `--backend`. A row priced under older rules says
  `priced under older rules, see: tools ai-spend workers --reprice`.

## How it works

### Where the data comes from

| Source | Reads by default | Override |
| --- | --- | --- |
| `claude` | `~/.claude/projects`, `~/.config/claude/projects` | `CLAUDE_CONFIG_DIR` |
| `codex` | `~/.codex/sessions`, `~/.codex/archived_sessions` | `CODEX_HOME` (comma list) |
| `grok` | `~/.grok/sessions/**/updates.jsonl`, plus the worker home | `GROK_HOME` |
| `opencode` | `~/.local/share/opencode` | `OPENCODE_DATA_DIR` |
| `amp` | `~/.local/share/amp` | `AMP_DATA_DIR` |
| `droid` | `~/.factory/sessions` | `DROID_SESSIONS_DIR` |
| `codebuff` | `~/.config/manicode*/projects` | `CODEBUFF_DATA_DIR` |
| `hermes` | `~/.hermes` | `HERMES_HOME` |
| `pi` | `~/.pi/agent/sessions` | `PI_AGENT_DIR` |
| `goose` | `sessions.db` in three known goose folders | `GOOSE_PATH_ROOT` |
| `kilo` | `~/.local/share/kilo/kilo.db` | `KILO_DATA_DIR` |
| `copilot` | `~/.copilot/otel` | `COPILOT_OTEL_FILE_EXPORTER_PATH` |
| `gemini` | `~/.gemini/tmp` | `GEMINI_DATA_DIR` |
| `kimi` | `~/.kimi`, `~/.kimi-code` | `KIMI_DATA_DIR` |
| `qwen` | `~/.qwen/projects` | `QWEN_DATA_DIR` |
| `openclaw` | `~/.openclaw` (and three older folder names) | `OPENCLAW_DIR` |
| `jev` | The GenesisTools usage ledger, `~/.genesis-tools/ai/usage/` | |

Codex rollouts count in both forms, `.jsonl` and `.jsonl.zst` (Codex 0.164 compresses its old rollouts). A Jev call's
feature label (`grep`, `listen`, ...) is its session, so `jev session` is the per-feature report.

A report loads the source groups on separate threads: Claude, Codex and Grok get one each, and the other sources share
one. A group whose thread fails, or does not finish within 5 minutes, is read inline instead, so a thread problem costs
time, never data. Measured 2026-10-04 on a 7-day window: Claude 2.9 s, Codex 1.1 s, Grok 0.3 s and the other sources
2.7 s, when read one after another. A report only opens transcripts written inside its window (plus a 3-day margin).
Measured on about 16 GB of Claude history: a 30-day summary over every source takes about 4.6 s, where the Claude-only
version read all history in 14 s. `Ctrl-C` ends a report at once.

### Line shapes and token arithmetic

`monitor`, `series`, `pivot`, `waste` and `plans` read Claude Code, Codex and Grok through one driver each
(`src/utils/ai/usage/spend/drivers/<agent>.ts`). A driver names the roots to walk, which files are transcripts, how
one line becomes a usage event, and how a model id falls back to a priced id. The walker, the mtime pruning, the tail
cache and the 10-minute sweep are shared, so a new agent adds one driver module and edits no table.

Which line carries the usage, and which rates price it:

- `claude`: a `type: "assistant"` line with `message.usage`, at the catalog rates for `anthropic`.
- `codex`: a `type: "event_msg"` line with `payload.type: "token_count"`; the model comes from the preceding
  `turn_context` line. Catalog rates for `openai`.
- `grok`: a `params.update.sessionUpdate: "turn_completed"` line, one event per entry in `usage.modelUsage`. Catalog
  rates for `xai` (xAI's list prices); Grok's own `costUsdTicks` only when the model has no rate.

The line shapes and token arithmetic mirror ccusage's Rust adapters, so the numbers line up with what ccusage reports
for the same files:

- **Codex.** `last_token_usage` is the per-turn figure, but it counts only when `total_token_usage` ADVANCED since the
  previous line: Codex re-emits an unchanged total on some events, and counting `last` again would double-bill the
  turn. With no `last_token_usage` at all, the difference of the cumulative totals is used. `cached_input_tokens` is a
  subset of `input_tokens`, so billable input is input minus cached. `reasoning_output_tokens` sits inside
  `output_tokens` and is never billed on top.
- **Grok.** `cachedReadTokens` and `cacheCreationTokens` are subsets of `inputTokens`, so the three parts sum back to
  `inputTokens`. `reasoningTokens` sits inside `outputTokens`. A row sums the turn's `modelCalls`, so it is priced at
  the base band: the per-request prompt lengths a long-context band needs are gone. The recorded `costUsdTicks`
  (1 tick = 1e-10 USD) is NOT the list price. It is the Grok CLI's own plan metering: recorded divided by list was
  about 1.0 until 2026-09-04 and 0.34 on every turn since 2026-09-16, so treating it as the cost understated Grok about
  three times. It stays on the event and is used only for a model the catalog cannot price.
- **Claude.** A one-hour cache write (`usage.cache_creation.ephemeral_1h_input_tokens`) bills at 2x input, a
  five-minute one at 1.25x; the event carries the one-hour share separately. Claude Code writes its prompt cache with
  the one-hour lifetime, so pricing every write at 1.25x understated its cache writes by 37.5%.
- **Claude.** Anthropic reports `input_tokens` already net of cache, so its four token fields are disjoint and nothing
  is subtracted.

### Pricing

Rates come from the static model catalog (`src/utils/ai/catalog/static.ts`) for the `anthropic`, `openai` and `xai`
providers (xAI's list prices come from `docs.x.ai/developers/pricing`). Nothing is fetched. The catalog's dated
promotions, long-context bands and Fast or priority tiers are
applied per request, at that request's own time and size.

A model id is looked up exactly, with one fallback: a trailing `-YYYYMMDD` or `-latest` suffix is stripped and the
lookup retried. Never an open-ended prefix match:

- Codex's task variants are peeled to a catalog id one suffix at a time: `gpt-5.3-codex-spark`, then `gpt-5.3-codex`,
  then `gpt-5.3`. `grok-4.6-build` peels to `grok-4.6`.
- The plan variants `-sol`, `-terra` and `-luna` are **not** peeled. Each carries its own rates, and folding them onto
  `gpt-5.6` ($5/$30) would bill Luna ($0.20/$1.20) at twenty-five times its price.
- An id that still matches nothing (`codex-auto-review`, a Grok Build model xAI does not list) is unpriced. The summary
  counts it as $0 and marks the model `(unpriced)`; `monitor` counts it as $0; the Codex reports print `null`;
  `series` and `pivot` count the unpriced events separately. A figure the agent recorded for it stands in when there
  is one.

You can override rates in `~/.genesis-tools/ai-spend/config.json` (see [Configuration](#configuration)).

#### Codex and OpenAI rates

Astra pricing comes from the shared catalog, verified against
[OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) and
[Astra's model page](https://developers.openai.com/api/docs/models/gpt-6-astra) on 2026-09-07:

| USD per million tokens | Input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Standard, input at most 272,000 | 10 | 1 | 12.50 | 50 |
| Standard, input above 272,000 | 20 | 2 | 25 | 75 |
| Fast, input at most 272,000 | 20 | 2 | 25 | 100 |
| Fast, input above 272,000 | 40 | 4 | 50 | 150 |

Each request is priced **before** grouping. Input length includes cached input and cache writes; output does not
determine the band. Above the boundary, the higher rates apply to the entire request, not just the excess tokens.
Cached tokens are subtracted from ordinary input, and reasoning tokens are already part of output. For example, 2,001
ordinary input + 270,000 cache-read + 1,000 output costs $0.65502 at standard speed. Exactly 272,000 input stays in
the short band.

The other models follow the same two-axis shape: doubled input and cache with 1.5x output above 272K, and Fast doubling
whichever band applies. Rates are ordinary input / cache read / cache write / output, in USD per million tokens:

- `gpt-5.6-sol`: $4/$0.40/$5/$20. This is the promotion OpenAI says is available at least through 2026-11-21; no
  unannounced post-promotion price is invented.
- `gpt-5.6-terra`: $2/$0.20/$2.50/$12, and `gpt-5.6-luna`: $0.20/$0.02/$0.25/$1.20, verified 2026-09-08 against
  `developers.openai.com`. They are separate catalog entries rather than aliases of `gpt-5.6`, which is why the suffix
  ladder above does not peel them.
- `gpt-6-sol`: $2/$0.20/$2.50/$10, and `gpt-6-luna`: $0.10/$0.01/$0.125/$0.50, verified 2026-09-23 against
  `developers.openai.com`. Sol is exactly
  half the GPT-5.6 promotional price; Luna is half on input and cache but not on output ($0.50, not $0.60).
- `gpt-6.1-sol` (released 2026-09-29, verified 2026-09-30) keeps GPT-6 Sol's shape and list price but halves cached
  input: $2/$0.10/$2.50/$10, and $4/$0.20/$5/$15 above 272K.
- `gpt-6.1-terra` (released 2026-10-26, verified 2026-10-27) is half of 6.1 Sol on every field: $1/$0.05/$1.25/$5, and
  $2/$0.10/$2.50/$7.50 above 272K.

Codex service tiers are read from `thread_settings_applied.thread_settings` and explicit `turn_context` fields, and
survive incremental parser resumes. A recorded `service_tier: priority` or `fast` selects Fast rates. A missing tier
uses standard rates and appears in `unspecifiedTierRequests`; today's configuration is never used to guess
yesterday's tier. Region-specific billing is not inferred. The `monitor` and `series` caches store each event's cost
from when it was parsed.
A code change to the parser or the catalog bumps their version and drops them. A pricing override in `config.json`
prices only events parsed after it.

### Accounts

`--account <id...>` takes the account ids of the AI config (`tools ai config account list`), plus two special rows:

- `claude-all`: every Claude transcript. `~/.claude/projects` records no login, so a per-account split there would be
  invented, and the shared tree is read once, not once per account.
- `(unbound)`: transcripts under a provider home that no account claims.

`--all-homes` also reads provider homes found on disk that no account is bound to. `pivot --by account` and `plans`
reach a Claude account through each session's last pin.

### What it reads and writes under `~/.genesis-tools/`

Writes:

- `ai-spend/cache/monitor-cache.json`: the `monitor` per-file cache.
- `ai-spend/cache/events-cache.json`: the event cache of `series`, `pivot`, `waste`, `plans` and `monitor --month`.
  It keeps a rolling 90 days and drops older events on every write.
- `ai-spend/cache/session-waste.json`: the `waste` items per transcript.
- `workers/cost-ledger.jsonl`: the worker ledger. Workers append to it; `--backfill` appends and `--reprice` rewrites
  it after copying it to `cost-ledger.jsonl.bak`.
- `ai-usage-dashboard/config.json`: the shared usage dashboard config. This tool writes only its
  `providers.<plugin id>.plans` (`plans price`).

Reads:

- `ai-spend/config.json`: pricing overrides.
- `ai/config.json`: the accounts.
- `ai-usage-dashboard/config.json`: the plan prices (`plans`).
- `ai/usage/`: the usage ledger behind the `jev` source.
- `ai-usage/cache/snapshots.json`: the latest plan and limit readings, written by the usage poller of `tools ai usage`
  (`plans`).
- `claude-history/index.db`, opened read-only: the weekly limit series (`plans`) and the session id lookup (`--id`).
- `ai-proxy/usage/clients.json` and `ai-proxy/usage/daily.json`: the proxy's client ledger and daily store (`proxy`).

The spend code makes no network calls, and nothing here costs money.

### Other doors

`tools claude spending` and `tools ai usage spend` mount the same command tree and print the same bytes.
`golden.test.ts` pins `daily`, `weekly` and `statusline` through `tools ai-spend` and `tools ai usage spend`. New
verbs are added here and appear under both aliases by themselves.

The spend library lives in `@genesiscz/utils/ai/usage/spend` (the drivers, the event cache, the reports, the series and
the pricing), so the usage alerts and attribution in `src/utils/` can read spend events. This folder keeps the commander
adapters (`lib/register.ts`, `lib/reports/commands.ts`, `lib/verbs.ts`), the chart renderer (`lib/render.ts`) and the
worker ledger (`lib/workers/`, which reads the claude, codex and grok worker stores). `lib/pricing.ts`,
`lib/reports/load.ts` and `lib/series.ts` are re-export shims for one release.

## Configuration

### Pricing overrides: `~/.genesis-tools/ai-spend/config.json`

The `pricing` key maps a model id to rates in USD per million tokens. A field you leave out keeps the catalog value,
and the catalog's context and tier `rules` stay unless you set `"rules": []` to clear them. The file is read only; no
command writes it.

```json
{
  "pricing": {
    "my-local-model": { "input": 0.5, "output": 1.5, "cacheWrite": 0.6, "cacheRead": 0.05 },
    "gpt-6-sol": { "cacheRead": 0.1 }
  }
}
```

### Plan prices: `~/.genesis-tools/ai-usage-dashboard/config.json`

`plans price` stores each price as `providers.<plugin id>.plans.<plan> = { "priceMinor": <cents>, "currency": "USD" }`.
Use the command rather than editing the file.

### Environment variables

- `CLAUDE_CONFIG_DIR`, `CODEX_HOME` (a comma list) and `GROK_HOME` move the three main agents' homes. The other
  sources' variables are in [Where the data comes from](#where-the-data-comes-from).
- `PROFILE=ai-spend` prints where the time went: per-source discover and parse times, file counts, aggregate and
  render.

```bash
PROFILE=ai-spend tools ai-spend
```

## For agents

- **`--json` is the stable interface** for dashboards and scripts; the tables are for humans.
  - `summary`, `sessions`, `today`: the aggregate report.
  - `daily`, `weekly`, `monthly`, `session`, `blocks`: ccusage's JSON shapes. One-source Codex reports use ccusage's
    Codex shape (`costUSD`, a `models` map) and add `analysis`; every other source uses `totalCost` and
    `modelBreakdowns`.
  - `pivot`, `plans`, `proxy`, `waste`: a versioned envelope (`schema` such as `usage.spend.pivot@1`, `generatedAt`,
    `window`, `selector`, `data`, `warnings`).
  - `monitor`, `series`, `workers`, `codex reviews`: their own objects, described above.
- **Exit codes.** 0 on success. A refused flag or value (an unknown source, a bad `--grain`, `--by`, `--mode` or
  `--timezone`, a bad report `--since` or `--until`, an ambiguous `--id`, two different lists in `--harness` and
  `--sources`) prints a one-line diagnostic with the valid values and exits 1.
- **Never let a prompt block a script.** `series` without `--grain` prompts in a terminal. Always pass it.
- **Pick the cheap call.** `monitor` is built for a number that refreshes often. `session --id <id> --json` prices
  one session and reads only its files.
- The GenesisTools app runs `pivot --heatmap --json`, `plans --json`, `proxy --json`, `waste --json`,
  `workers --by backend,model,outcome --json` and `session --id <id> --json`. Keep those shapes stable, and keep the
  four strict `monitor --json` leaves described under [Status bars](#status-bars-monitor).
- For a worker's cost while it runs, read its turn report or `status --json` (`cost`), which come from the same ledger.

## Troubleshooting

- **A report takes a long time.** Without `--since`, `daily`, `weekly`, `monthly`, `session` and `blocks` read every
  transcript ever written. Pass `--since 30d`. `PROFILE=ai-spend` names the slow phase.
- **`--since 2w` read 30 days.** `summary` and `sessions` take only `Nd` or `YYYY-MM-DD`, and an unreadable
  value falls back to `30d` without an error. `pivot` and `waste` accept `2w`.
- **A model shows `(unpriced)`, `unknown` or `null`.** The catalog has no rate for that id. Add it under `pricing` in
  `~/.genesis-tools/ai-spend/config.json`. In the Codex reports, `knownCostUSD` is the priced subtotal. An override
  prices only events parsed after it: days already in the `monitor`/`series` event cache (`pivot`, `waste`, `plans`,
  `monitor --month`) keep their old cost. No command rebuilds that cache; move `ai-spend/cache/events-cache.json`
  aside to price those days again.
- **`statusline` prints `No input provided` and exits 1 in a terminal.** It needs Claude Code's hook JSON on stdin.
  Test it with `echo '<hook json>' | tools ai-spend statusline`.
- **`--model` or `--project` changed nothing.** They filter `summary`, `sessions` and `today` only. The command line
  accepts them after any command, but the ccusage reports and the other commands ignore them.
- **`--harness opencode` is refused on `series`, `pivot`, `waste`, `plans` or `monitor`.** Those read Claude Code,
  Codex and Grok only. `monitor` refuses `--harness` altogether; read `agents` in `--json`.
- **`session --id` prints "No usage found for session".** Nothing matched the id. Pass more of it, or the full Codex
  rollout name.
- **`series`, `pivot` or `waste` shows nothing before a date 90 days ago.** Their event cache keeps 90 days. Use
  `tools ai-spend monthly --since <date>` for older spend.
- **Today's number differs between `today` and `monitor`.** `today` is the UTC day; `monitor` uses local midnight.
- **A brand-new session is missing from `monitor`.** A new transcript in a previously quiet deep folder appears at the
  next full sweep, at most 10 minutes later.
- **Grok costs about three times what the Grok CLI shows.** The CLI's `costUsdTicks` is its plan metering, not the
  list price. This tool prices Grok at xAI's list rates.
- **There is no per-account Claude split in `series` or `monitor`.** Claude transcripts record no login; they report
  as `claude (all accounts)`. Per-account Claude numbers come from the call log.
- **`plans` says `no price`, `not USD` or `(30 d)`.** Set the price with `plans price`; the paid-back multiple needs a
  USD price; `(30 d)` means the account names no renewal day, so the cycle is the last 30 days.
- **`workers` says "No worker spend in that window", or TURNS are 0.** The sessions ran before the ledger. Run
  `tools ai-spend workers --backfill --dry-run`, then without `--dry-run`.
- **A worker cost line says `priced under older rules`.** Run `tools ai-spend workers --reprice --dry-run`, then
  without `--dry-run`. The previous ledger stays as `cost-ledger.jsonl.bak`.

## Related

- [`tools ai`](../ai/README.md): `tools ai usage spend` is an alias of this tool; `tools ai usage` polls plan limits
  and holds the call log.
- [`tools claude`](../claude/README.md): `tools claude spending` is another alias. `tools claude usage` is a different
  thing, an interactive dashboard of account usage and limits; this tool is the historical spend view.
- [`tools ask`](../ask/README.md): `tools ask usage` gives the tokens and cost of the `ask` tool itself.
- [`tools ai-proxy`](../ai-proxy/README.md): the ledger behind `proxy`.
- [`tools codex`](../codex/README.md) and [`tools grok`](../grok/README.md): the headless workers that `workers` prices.
- [`tools jev`](../jev/README.md): the calls behind the `jev` source.
- [`tools json`](../json/README.md): pipe any `--json` output through it, for example `tools ai-spend --json | tools json`.

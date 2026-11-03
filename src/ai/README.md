# tools ai

> **Unified AI toolkit: translate, summarize, classify, generate images, and manage accounts and models.**

The user-facing face of the AI subsystem under `src/utils/ai/`. The verbs here are deliberately small. The substantial part is `ai config`, which owns every account, credential and default that the rest of the toolkit resolves against.

---

## Commands

| Command | Description |
|---------|-------------|
| `translate [text]` | Translate text between languages |
| `summarize [file]` | Summarize text from a file, stdin, or the clipboard |
| `image <prompt>` | Generate an image from a text prompt (requires `HUGGINGFACE_TOKEN`) |
| `classify [text]` | Classify text into categories using semantic similarity |
| `models` | Manage downloaded local models |
| `config` | Manage AI accounts, defaults, links, secrets and diagnostics |
| `accounts` | Browser logins, logout, and vendor-home discovery for the subscription providers |
| `usage` | Quota and rate-limit windows for every provider that reports them, plus the polling daemon |

## Quick start

```bash
tools ai translate "dobrý den" --to en
tools ai translate "good morning" --to cs --clipboard
echo "long text" | tools ai summarize -
tools ai summarize notes.md --max-length 200
tools ai summarize                                  # summarizes the clipboard
tools ai classify "the build fails on CI" --categories bug,feature,question
tools ai image "a red bicycle in the rain" -o bike.png
```

### Verb options

`translate`: `--to <lang>` (required), `--from <lang>` (auto-detect when omitted), `--provider <provider>` (`local-hf`, `cloud`, `darwinkit`), `-c, --clipboard`.

`summarize`: `--max-length <n>`, `-c, --clipboard`. The file argument accepts `-` for stdin, and omitting it reads the clipboard.

`classify`: `--categories <list>` (comma-separated).

⚠️ **`summarize` and `classify` register `--provider`, but currently ignore it.** `summarize` calls `AI.summarize(input, { maxLength })` and `classify` calls `classifyText(input, categories)`, neither of which receives the flag (`src/ai/index.ts:163` and `:276`). Passing it silently gets you the default implementation, so do not rely on it to steer either verb. It is documented here rather than omitted so nobody assumes the flag works. `translate` does honour `--provider`.

`image`: `-o, --output <path>`, `--model <model>` (default `stabilityai/stable-diffusion-xl-base-1.0`).

---

## Local models

```bash
tools ai models list                    # downloaded models with sizes
tools ai models download <model-id>     # fetch one for local use
tools ai models clean                   # remove cached models
```

Local providers avoid a network round trip and an API bill, at the cost of disk and a first-run download. `models clean` is the disk-recovery path.

---

## `ai config`: accounts, defaults, secrets

```bash
tools ai config account add                     # add an account, secrets go into the vault
tools ai config account list
tools ai config account show <id-or-name>       # secret values are never resolved
tools ai config account edit <id-or-name>
printf '%s' "$XAI_API_KEY" | tools ai config account edit <id-or-name> --api-key-stdin   # give an existing account a key
tools ai config account test <id-or-name>       # resolve the credential and bind the provider
tools ai config account rm <id-or-name>

tools ai config default set <task> <model-ref>  # point a task at a model or account
tools ai config default list

tools ai config link                            # what references an account

tools ai config secret set <path> [secret]      # value comes from stdin or a file; does not link it to an account
tools ai config secret ls [prefix]              # paths only, never values
tools ai config secret rotate                   # new master key, re-encrypt everything
tools ai config secret export                   # passphrase-protected copy
tools ai config secret import <file>

tools ai config doctor                          # master key, vault, credentials, links, expiries
```

### How credentials are stored

Nothing sensitive is in the config file. Accounts hold **references** into an AES-256-GCM vault at `~/.genesis-tools/security/vault.json`, with a per-entry key derived by HKDF. The master key is resolved from a ladder: the `GENESIS_TOOLS_MASTER_KEY` environment variable, then the OS keychain, then an opt-in key file.

Config itself lives at `~/.genesis-tools/ai/config.json`. It is re-read when its mtime changes, so a long-running proxy notices a login performed in another terminal.

### Model references

The resolution ladder accepts several forms, most specific first:

```
grok-4-fast                  # bare model id
xai/grok-4-fast              # provider-qualified
@account/<id>:<model>        # a specific account
@proxy/<slug>/<model>        # via tools ai-proxy
```

When nothing is specified, the ladder falls back to the app default, then the task default, then the global default.

---

## `ai accounts`: browser logins, logout, home discovery

`ai config account` enters a credential you already hold. `ai accounts` OBTAINS one: the browser OAuth flows, the long-lived token mint, the external `grok login`, and the discovery of vendor home directories. It covers only the subscription plugins that declare account features (`anthropic-sub`, `openai-sub`, `grok-sub`), addressed by alias or plugin id.

```bash
tools ai accounts list [--provider claude|codex|grok] [--json]   # which credentials each account holds, never their values
tools ai accounts show <account> [--json]                        # identity, credential kinds, bound homes; never polls
tools ai accounts login [name] --provider <p> [--home <dir>] [--auth-file <f>]
tools ai accounts login-long [name] --provider claude [--setup-token]
tools ai accounts login-secondary [name] --provider claude
tools ai accounts logout [name] [--provider <p>] [--oauth|--long-lived|--secondary|--auth-file|--all] [-y]
tools ai accounts discover [--provider <p>] [--bind] [--json]    # vendor homes on disk; --bind is the only writing path
tools ai accounts who [--json] [--all]                            # live Claude Code processes and the account each one bills
```

`--provider` is an enumerated flag: in a TTY it prompts, in a pipe (or with an unknown value) it prints the possible values and exits 1.

One core, several doors. `tools claude login|login-long|login-secondary|logout|who`, `tools codex login`, `tools grok login` and `tools ai-proxy accounts login codex` call the same functions in `src/ai/lib/accounts/` with the provider pinned, so a behaviour cannot exist behind one door and not the others.

Where a login lands:

- **claude**: access and refresh token in the vault; the first login also becomes the default account for the `claude` and `ask` apps when they have none.
- **codex**: the codex home's `auth.json` (`~/.codex` or `--home`), in the shape the official CLI reads, and the account stores that path. An account may instead hold a vault-stored token pair, the way `tools ai-proxy accounts login codex` used to write it; both keep working.
- **grok**: no in-process flow. The command prints `grok login` with `GROK_HOME` set, offers to run it, then binds the `auth.json` it wrote.

A re-login merges onto the account of the same name and keeps its long-lived token, secondary grant, label and apps. When the browser proves a different identity than the account already stores, the write needs a confirmation in a TTY and is refused in a pipe.

## `ai usage`: quota across every provider

One dashboard over every plugin that declares `accounts.usage`. The TUI is the default; `--json` and `--no-tui` never import Ink, which is what keeps a scripted read cheap.

```bash
tools ai usage [--provider claude|codex|grok] [--account <name>] [--range 60m|6h|24h|7d] [--json|--no-tui] [--fresh]
tools ai usage daemon register|unregister|status
```

`--provider` and `--range` are enumerated: passed with no value, or with a value that is not on the list, they print the possible ones and exit 1.

`tools claude usage`, `tools codex usage` and `tools grok usage` are the same dashboard pinned to one provider. `tools claude usage` additionally keeps its Sessions tab, the `--token`, `--watch` and `--scored` flags, and its `usage sessions` subcommand.

`daemon register` owns the single `ai-usage-poll` task and removes the old claude-only `claude-usage-poll` on the way through. Running it once is the whole migration. `tools claude daemon` is an alias for the same three subcommands.

### `ai usage limits`: windows now, over time, the forecast and the advisor

```bash
tools ai usage limits [--provider ...] [--account ...] [--cached|--fresh] [--scored] [--json]
tools ai usage limits series [--since 24h] [--until <when>] [--tz <zone>] [--step auto|raw|5m] [--agg last|minmax|raw] [--kind session weekly ...] [--json]
tools ai usage limits forecast [--provider <id>] [--account <name>] [--json]
tools ai usage limits advise [--model fable] [--cached|--fresh] [--json]
tools ai usage limits health [--since 24h] [--provider ...] [--account ...] [--json]
```

`limits`, `limits series` and `limits advise` with `--json` print one envelope, `{ schema: "usage.<verb>@1", generatedAt, window?, selector, data, warnings }`, from the shared contract in `@genesiscz/utils/ai/usage/contract` (the `--since`/`--until`/`--tz` grammar, the `--account` selector, the step default). `--since` takes a duration (`90m`, `7d`), a date (local midnight in `--tz`), an ISO instant with an offset, or `today`, `yesterday`, `week` (Monday start) and `month`; `--range`, `--from`, `--to`, `--hours` and `--timezone` are hidden aliases. `--account` takes an id, a name, `provider/name` or a unique part of a name, and an ambiguous value lists its candidates. `limits forecast` is the exception: it prints `tools hub forecast`'s own `ForecastResult` with no envelope, and its `--account` is an exact account name, not the selector.

- `limits` is every account's windows now. `--scored` adds `data.ranked`: each provider's accounts ranked by its own ranker (each provider's usage feature declares it as `usage.ranker`, and `rankAccounts` in `@genesiscz/utils/ai/usage/account-rank` reaches it; Claude's scorer, Codex and Grok the shared window ranker).
- `limits series` is the series door `/api/ai/usage/series` also reads: points or minmax bins, the resets, the window's availability spans (`limited`, `absent`, `unknown` for rows older than the column), the current value, and a forecast with the pace band and the safe pace.
- `limits forecast` is an alias of `tools hub forecast`: the same flags, the same runner, the same bytes. `tools hub forecast` stays the real command.
- `limits advise` names the next account per workload (`default`, `fan-out`, `long-run`, and `model:<name>` for each `--model`), how long it lasts at the recent burn, and the weekly capacity each account leaves unused at its reset.

- `limits health` is the poll coverage per account over the window: the current outcome (`ok`, `stale`, `error`, `blocked`, `backoff`, `needs-login`, or `unmeasured` when no poll reaches the present), since when, the share of the window some poll measured, the gaps of 5 minutes or more nobody polled, and the reading source (`endpoint`, `headers`, `app-server`, `billing-api`). The daemon tick writes the runs to `usage_poll_runs`, one row per account while its outcome stays the same. It never polls: a flat line now reads as idle, unmeasured, stale or held back.

The same answers are MCP tools under the `usage` capability (`usage_limits`, `usage_series`, `usage_forecast`, `usage_advise`); those read the last poll's file and never poll.

### `ai usage events`: rate limits, cooldowns and probes

```bash
tools ai usage events [--since 24h] [--kind usage-429 rate-limited cooldown poll-backoff org-blocked probe-refused probe] [--provider ...] [--account ...] [--limit 50] [--json]
```

Facts that lived only as day-log text, newest first, as `usage.events@1` with counts per kind: the usage endpoint's 429s, the proxy's rate-limited answers and the cooldowns it took, the poll gate's pauses, organization blocks, refused quota probes, and one row per account, model and day counting the probes sent. `recordUsageEvent` (`@genesiscz/utils/ai/usage/events/record`) writes them where they happen and never throws; the proxy maps its provider names to plugin ids first. `--account` matches an id or a name exactly, proxy account names included.

### `ai usage alerts`: the alert engine

```bash
tools ai usage alerts [list] [--since 7d] [--rule ...] [--unacked] [--provider ...] [--account ...] [--json]
tools ai usage alerts ack <id...> | --all
tools ai usage alerts rules [--json]
tools ai usage alerts test <rule> [--account ...] [--send] [--json]
```

The daemon tick runs the engine after each poll round and records every alert it fires in `usage_alerts`, which is also its dedupe memory: one alert per dedupe key per window cycle, again only when the severity rises (each rule's `refire`). The rules (`ALERT_RULES` in `@genesiscz/utils/ai/usage/alerts/rules`):

- `threshold`: the percent thresholds the notifier used (session `[80]`, weekly `[20, 40, 60, 80]`; scoped and monthly windows use the weekly list).
- `predicted-exhaust`: the forecast runs a window out before its reset within its lead time (45 min for 5h, 12 h weekly, 6 h scoped), only while its use rose in the last 30 minutes; again in one cycle only when the run-out moves 30 minutes earlier.
- `limit-state-change`: a window disappeared (an account lost its 5-hour limit) or came back.
- `health`: the poller recorded nothing for 10 minutes, an account is paused by the poll gate, refused by its organization or has no credential, a refresh grant expires within 7 days, or the probe budget refused a probe.
- `rate-limited`: 3 rate-limit answers for one account within 10 minutes.

Settings live in `~/.genesis-tools/ai-usage-dashboard/config.json` under `alerts`, nested by axis: `alerts.global` (`enabled`, `quietHours: { start, end }`), `alerts.rules.<rule>` (`enabled`, `channels`, and the rule's own keys), and `alerts.providers.<plugin id>.rules.<rule>.enabled` to turn one rule off for one provider. The channels are `macos` (a banner; it honours `notifications.macos` and `notifications.sound`, and quiet hours hold it) and `inbox` (an unread card in the GenesisTools widget). Defaults: threshold to `macos`, predicted-exhaust to both, limit-state-change and rate-limited to `inbox`, health recorded only. The loader moves the old `notifications.thresholds` to `alerts.rules.threshold` once; a read-only load migrates in memory and writes nothing. On its first tick the engine seeds its record from the old notifier's trackers, so no threshold already announced fires again.

- `budget`: a window with a budget burns more today than its allowance times 1.2 (`over pace`), or eats into its reserve; and "use it or lose it": a budgeted weekly or monthly window resets within 6 hours with 40% or more left (`useItBudgetedOnly: false` extends that to every window).

`list`, `rules` and `test` never write; `test` judges the last poll's snapshots without polling or recording, and `--send` tries the rule's channels with its findings or one test card.

### `ai usage limits spikes`, `attribution` and `drift`: who ate the bar

```bash
tools ai usage limits spikes [--since 24h] [--min-delta 5] [--window-min 10] [--kind session] [--account ...] [--json]
tools ai usage limits attribution [--kind weekly] [--since <when>] [--account ...] [--json]
tools ai usage limits drift [--since 28d] [--kind weekly] [--min-windows 5] [--pad 5] [--record] [--json]
```

- `spikes` (`usage.limits.spikes@1`) finds every rise of a window by `--min-delta` points within `--window-min` minutes and lists the sessions that spent on that account in the span (5 minutes before its first reading included), with their main-loop and sub-agent dollars and share. Spend of the provider that no account claims is `unattributed (another host or a missing pin)`.
- `attribution` (`usage.limits.attribution@1`) splits each window's rise since its last reset (or since `--since`) by project and session, in dollars and in points of the bar at the account's dollars per point; unpinned spend is its own slice.
- `drift` (`usage.limits.drift@1`) measures tokens and dollars per point per account, model and ISO week over exclusive windows (the account's bar rose and no other account of its provider rose within `--pad` minutes), with a 95% bootstrap interval. A week whose interval misses the earlier weeks' reads `limit cut?` or `limit raised?`. `--record` writes the weeks into `limit_drift`.

Sessions reach accounts through each harness's spend driver (`MonitorDriver.sessionAccount`): Claude transcripts name no account, so the pin journal answers (the LAST pin of a session, flagged `approximate`); Codex and Grok answer by the account that owns the transcript's home, then by the pin. Every session row carries `next`, its `tools ai sessions report <id>`.

### `ai usage budgets` and `ai usage digest`

```bash
tools ai usage budgets [list] [--provider ...] [--account ...] [--json]
tools ai usage budgets set --account <name> --kind weekly|session|monthly [--reserve 15] [--daily 12]
tools ai usage budgets set --spend-daily 30 [--provider codex]
tools ai usage budgets rm --account <name> --kind weekly | --spend [--provider codex]
tools ai usage digest [--day [YYYY-MM-DD] | --week [YYYY-MM-DD]] [--tz Europe/Prague] [--json | --write]
```

- Budgets live in the usage dashboard config under `budgets`, nested by axis: `budgets.global.spend.dailyUsd`, then `budgets.providers.<plugin id>.spend.dailyUsd` and `budgets.providers.<plugin id>.accounts.<account id>.<kind>.{ reservePct, dailyAllowancePct }`. A missing key is no budget. `list` (`usage.budgets@1`) shows each budgeted window's pace today (the allowance spreads what is left above the reserve over the days to the reset) and each spend target against today's spend. The `budget` alert rule reads the same keys.
- The daemon tick rolls yesterday and today into `usage_daily` at most every 15 minutes: one row per account, window and local day with its first, last and highest reading, its resets, the cycles that reached 90% and the minutes measured. The rows outlive the 30-day prune of `usage_snapshots`.
- `digest` (`usage.digest@1`) folds one day (default yesterday) or one Monday-to-Sunday week (default last week) into limits per account (an absent window reads "no limit since"), spend by provider and model with the five costliest sessions, worker cost by backend, the alerts that fired, and the windows forecast to run out before their reset. The text output is the markdown note; `--write` puts it into the hub digest folder (`tools hub digest config --folder`).

### `ai sessions report`: one session's cost and cache

```bash
tools ai sessions report <session-id> [--provider claude|codex|grok] [--top 10] [--json]
```

The report reads the session's `analysis` facts through its reader (`NativeSessionReader.analysis`: `callTrace`, `compactions`, `quotaReadings`), so Claude, Codex and Grok answer the same shape: cost by model and by main loop and sub-agents, the cost without any cache and the savings, the quota weight (cache reads count a tenth), the costliest calls with their tags (`cold-cache`, `partial-cold`, `large-cache-write`, `high-output`, `subagent`), the cache losses with their cause, and the longest gaps. A fact a harness does not record is listed under `unsupported` with its reason.

### `ai usage spend`: the `tools ai-spend` tree

`tools ai usage spend <verb> ...` is an alias of [`tools ai-spend <verb> ...`](../ai-spend/README.md): the same commands, flags and bytes. `tools ai-spend` stays the documented path, and a new spend verb lands in its tree. `--harness <list>` picks transcript data by the agent that wrote it (`--sources` and `--backend` are the older names); a limits verb refuses `--harness`, because limit windows belong to a provider (`--provider`).

### `ai usage sessions`: one list across Claude, Codex and Grok

```bash
tools ai usage sessions [--provider claude|codex|grok] [--hours 24] [--min 10] [--limit 50] [--json] [--fresh] [--cost]
```

`--cost` adds `spentUsd` (the list-price dollars of the session's calls), `usdPerHour` (its calls of the last hour) and `coldRebuildUsd` (what the next prompt costs extra when the cache expired first: the context at the write rate of its tier minus the read rate) to each row. It reads each listed transcript, so it is opt-in; without it the rows keep their bytes.

Computing the list walks every native session home and stats about 12,000 files, which costs ~1.8 s of CPU. Genesis.app asks for the same list every 35 seconds, so `--json` reads a resident answer at `~/.genesis-tools/ai/usage-sessions.json` when it is under 90 seconds old and answers the same query: **0.22 s of CPU instead of 1.8 s**, with byte-identical rows.

The `ai-usage-poll` tick recomputes that file once a minute, so a poller on any cadence finds it warm. The tick refreshes only the query the CLI last asked for, and only while something has asked within the hour, so an idle machine pays nothing.

- The payload carries `fetchedAt` (when the rows were computed, not when you asked) and `cached: true|false`, so a consumer can judge the age itself.
- `--json --fresh` recomputes and rewrites the file. Without `--json`, `--fresh` renders an uncached table and does not write.
- The human table is never served from the cache.

## `ai warmup`: start a session timer on every account

One tiny request per account (five output tokens, on the smallest model where the provider lets a ChatGPT-style account pick one; codex accounts reject a pinned slug, so they use the account's default model), so a rolling window starts now instead of on the first real call. An Anthropic account without a 5-hour limit has no session timer: it is skipped when its weekly window already runs, and the daemon's session warmup never sends to it. The selection, the send and the report live in `@genesiscz/utils/ai/warmup`; `tools claude warmup`, `tools codex warmup` and `tools grok warmup` are the same command pinned to one provider, and the usage daemon's scheduled warmups call the same function.

```bash
tools ai warmup                       # pick accounts (TTY)
tools ai warmup --all [--provider codex] [--json]
tools ai warmup personal cdx-work     # by name or id, any provider
```

Anthropic falls back to a long-lived (`tools claude login-long`) token when the OAuth grant is dead and reports `used login-long token`. Codex goes through the ChatGPT backend, which only streams and accepts only the account's own model list, so the codex warmup always uses the account's default model. Exit code 1 when any account failed; the failing line carries the vendor's message and the re-login command.

## 🛑 Diagnostics do not mutate

`doctor`, `account test`, `accounts list`, `accounts show`, `accounts discover` (without `--bind`) and `accounts who` are read-only by contract. They resolve and report, and they refuse to spend a single-use credential.

This is not a stylistic preference. Both commands once rotated Anthropic OAuth refresh tokens simply by reaching a shared auth path that refreshed on expiry, which meant **diagnosing an account could break it**. The guard now lives in the shared function, immediately before the call that spends the token, rather than at each call site.

## Notes

- `tools ai-proxy link` registers a local proxy as a real account, which is what makes `@proxy/...` references resolve here.
- Cost accounting for calls made through this subsystem is recorded automatically. See `tools ask usage` for `ask` analytics and [`tools ai-spend`](../ai-spend/README.md) for Claude Code session spend.
- `image` needs `HUGGINGFACE_TOKEN` in the environment. It is the one verb here that is not covered by the account system.

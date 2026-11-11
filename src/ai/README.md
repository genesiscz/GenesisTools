# tools ai

The user-facing face of the AI subsystem under `src/utils/ai/`: small text verbs (translate, summarize, classify,
image) plus the accounts, credentials, quota windows, session reports, statusline and token gate that the rest of
GenesisTools resolves against. Use it to log in to a subscription, see how much of each limit is left, or find out what
a coding-agent session cost.

## Quick start

```bash
tools ai translate "dobrý den" --to en               # translate; on macOS the source language is detected
echo "long text" | tools ai summarize -              # summarize stdin (the `-` is optional in a pipe)
tools ai config account list                         # every configured account, secrets redacted
tools ai accounts login --provider claude            # browser login for a subscription account
tools ai usage                                       # quota dashboard for every provider (TUI)
tools ai sessions tail <session-id> -f               # follow a Claude, Codex or Grok session as turns
```

`tools ai` with no arguments in a terminal opens a menu (translate, summarize, image, classify, models, config).

## Commands

Every group below matches `tools ai --help`. Run `tools ai <group> <command> --help` for the full flag list.

### Text verbs

```bash
tools ai translate "dobrý den" --to en
tools ai translate "good morning" --to cs --clipboard
echo "long text" | tools ai summarize -
tools ai summarize notes.md --max-length 200
tools ai summarize                                   # in a terminal: summarizes the clipboard
tools ai classify "the build fails on CI" --categories bug,feature,question
tools ai image "a red bicycle in the rain" -o bike.png
```

- `translate [text]`: `--to <lang>` (required), `--from <lang>` (detected when omitted),
  `--provider <id>`, `--model <id>`, `-c, --clipboard` (copy the result).
- `summarize [file]`: `--max-length <n>`, `--provider <id>`, `--model <id>`, `-c, --clipboard`. The file `-` reads
  stdin. With no file it reads piped stdin, or the clipboard when stdin is a terminal.
- `translate` and `summarize` call the AI task facade (`ai.translate`, `ai.summarize`). `--provider` and `--model`
  choose for that call only and are never saved; a lone `--provider` uses that provider's default model for the task.
  Change the saved default with `tools ai config default set <task> <model-ref>`. A transient failure is retried up
  to three times.
- `classify [text]`: `--categories <list>` (required, comma-separated, at least two; fewer exits 1), `--provider`.
- `image <prompt>`: `-o, --output <path>` (required), `--model <id>`.
- `translate` and `classify` read stdin when no text is given.
- On macOS, `translate` without `--from` detects the language with the system language detector and prints
  `Detected language: <code>` on stderr. When detection fails, the provider detects it.
- `classify` uses the macOS classification helper (semantic similarity against your categories).
- `image` defaults to `stabilityai/stable-diffusion-xl-base-1.0` and installs `@huggingface/inference` on first use.

⚠️ **`classify` registers `--provider`, but ignores it.** It calls `classifyText(input, categories)`, which does not
receive the flag. Passing it silently gets you the default implementation. It is documented here rather than omitted
so nobody assumes the flag works.

### Local models

```bash
tools ai models list                       # downloaded models with sizes and a total
tools ai models download <model-id>        # e.g. Xenova/opus-mt-cs-en or whisper-small
tools ai models download <model-id> --dtype q8   # auto|fp16|fp32|q4|q8|int8|uint8 (default fp32)
tools ai models clean [--older <days>]     # remove cached models, optionally only older ones
```

Local providers avoid a network round trip and an API bill, at the cost of disk and a first-run download.
`models clean` is the disk-recovery path. Models live in the Hugging Face caches: `~/.cache/huggingface/hub` (it
honours `HF_HOME`) and the cache directory of `@huggingface/transformers`.

### `ai config`: accounts, defaults, links, secrets

`ai config` enters and manages a credential you already hold. With no subcommand in a terminal it opens an
interactive menu; in a pipe it exits 1 and names `--help`.

```bash
tools ai config account add                     # add an account; secrets go into the vault
tools ai config account list [--provider <id>] [--enabled-only] [--json]
tools ai config account show <id-or-name>       # secret values are never resolved
tools ai config account edit <id-or-name>       # --enable|--disable, --label, --tag, --rename, ...
printf '%s' "$XAI_API_KEY" | tools ai config account edit <id-or-name> --api-key-stdin   # give an account a key
tools ai config account test <id-or-name> [--live] [--json]   # resolve the credential and bind the provider
tools ai config account rm <id-or-name> [--force]             # also removes its vault entries

tools ai config default set <task> <model-ref> [--app <app>] [--provider <id>]
tools ai config default list [--json]

tools ai config link ls [id-or-name] [--json]   # what references an account

tools ai config secret set <path> [--stdin]     # value from stdin or a hidden prompt; a value on argv is refused
tools ai config secret ls [prefix] [--json]     # paths only, never values
tools ai config secret rotate [--yes]           # new master key, re-encrypt everything
tools ai config secret export --out <file> [--passphrase-env <VAR>]
tools ai config secret import <file> [--passphrase-env <VAR>]

tools ai config doctor [--live] [--json]        # master key, vault, credentials, links, expiries
```

- `account add` flags: `--provider <id>`, `--name`, `--label`, `--tag` (repeatable), `--endpoint <url>` for gateway
  or self-hosted providers, `--billing subscription|metered|free` (default from the plugin kind), `--api-key-stdin`
  (never from argv), `--use-env <vars>` (env vars the account may fall back to, or `true`/`false`), `--auth-file`,
  `--data-dir`, `--json`. Without flags it prompts. Without a TTY, `--provider` and `--name` are required, and a
  missing one exits 1.
- `account edit` also takes `--endpoint`, `--use-env`, `--auth-file`, `--data-dir` and `--api-key-stdin`.
  `--rename` keeps the id, so every reference stays valid. `--tag` replaces the existing set.
- `account rm` refuses while something still references the account, the accounts that the ai-proxy config bills
  included, so it does not delete an account the running proxy still routes to. That check reads only the proxy's
  `account: "@account/<id>"` refs. A proxy account linked only by an old name field (`grok.accountName`,
  `anthropicSub.accountName`, `openaiSub.accountName`) gets its ref when `tools ai-proxy serve` starts; until then,
  or when that rewrite failed, the check does not see it, so look for those fields in the proxy config before you
  remove an account. A proxy config that cannot be read counts as no references at all, so the removal goes ahead
  without `--force` when nothing else holds the account: check that `tools ai-proxy` reads its config before you
  remove an account it might use. `--force` skips that check too: it
  removes the account and its vault entries anyway, and the proxy config can keep a reference to an account that is
  gone.
- `secret set` does not link the value to an account. `rotate`, `export` and `import` need `--yes` or
  `--passphrase-env` without a TTY.
- `default set` tasks: `chat`, `embed`, `transcribe`, `tts`, `summarize`, `translate`, `classify`, `sentiment`,
  `image`, `realtime`.

### `ai accounts`: browser logins, logout, home discovery

`ai config account` enters a credential you already hold. `ai accounts` OBTAINS one: the browser OAuth flows, the
long-lived token mint, the Codex and Grok browser logins, and the discovery of vendor home directories. It covers only
the subscription plugins that declare account features (`anthropic-sub`, `openai-sub`, `grok-sub`), addressed by alias
(`claude`, `codex`, `grok`) or plugin id.

```bash
# which credentials each account holds, never their values
tools ai accounts list [--provider claude|codex|grok] [--json]
tools ai accounts show <account> [--json]                        # identity, credential kinds, bound homes; never polls
tools ai accounts login [name] --provider <p> [--home <dir>] [--auth-file <f>] [--import-native] [--broker]
tools ai accounts login-long [name] --provider claude [--setup-token]
tools ai accounts login-secondary [name] --provider claude
tools ai accounts logout [name] [--provider <p>] [--oauth|--long-lived|--secondary|--auth-file|--all] [-y]
tools ai accounts discover [--provider <p>] [--bind] [--json]    # vendor homes on disk; --bind is the only writing path
# live Claude Code processes and the account each one bills
tools ai accounts who [--json] [--all]
tools ai codex login [name]                                      # accounts login pinned to codex, same flags
```

- `login` has three modes, and you choose one: the default vault login (`--broker` is the Codex alias of it),
  `--import-native`, or an explicit `--home` / `--auth-file`. A combination exits 1.
- `login --auth-file` binds an existing credential file instead of running OAuth. When the file is missing, the
  provider's browser flow runs and creates it. `--import-native` binds the native CLI's current credential file and
  fails when there is none.
- `login-long --setup-token` skips the prompt and mints the token through the OAuth flow.
- `logout` removes credentials and keeps the account entry. `--all` removes every credential the provider declares.
- `who --all` also lists helper processes (MCP servers, SDK launchers).
- `--provider` is an enumerated flag: in a TTY it prompts, in a pipe (or with an unknown value) it prints the possible
  values and exits 1.

One core, several doors. `tools claude login|login-long|login-secondary|logout|who`, `tools codex login`,
`tools grok login` and `tools ai-proxy accounts login codex` call the same functions in `src/ai/lib/accounts/` with
the provider pinned, so a behaviour cannot exist behind one door and not the others.

Where a login lands:

- **claude**: access and refresh token in the vault. The first login also becomes the default account for the
  `claude` and `ask` apps when they have none. Claude has no credential file, so `--home`, `--auth-file` and
  `--import-native` are refused.
- **codex** and **grok**: an in-process browser OAuth flow (a loopback listener, with a code-paste prompt as the
  fallback). By default the grant goes into the vault.
  - With `--home <dir>` the grant is written to `<dir>/auth.json`, in the shape the native CLI reads, and the account
    stores that path.
  - `--auth-file <path>` binds an existing file, or creates it through the flow when it is missing.
  - `--import-native` binds the native CLI's current file: `~/.codex/auth.json` (or the first `CODEX_HOME` entry) and
    `~/.grok/auth.json` (or `GROK_HOME`).
  - Both flows need a TTY. Without one, bind a file that already exists with `--auth-file <path>`.

A re-login merges onto the account of the same name and keeps its long-lived token, secondary grant, label and apps.
When the browser proves a different identity than the account already stores, the write needs a confirmation in a TTY
and is refused in a pipe.

### `ai gate`: hand a token to another app after approval

Another process (for example `tools say`, or an editor extension with no key in its environment) asks the gate for an
account's access token or an API key. GenesisTools.app shows who asks and confirms with Touch ID.

```bash
tools ai gate request --client my-app --pid 4242 --provider anthropic-sub --account work
tools ai gate request --client my-app --provider xai --print-token   # only the key, for a `!command` credential
tools ai gate grants [--json]                # remembered approvals that have not expired (read-only)
tools ai gate revoke [client] | --all        # forget remembered approvals
tools ai gate audit [--limit 20]             # the last decisions (read-only)
tools ai gate status                         # is the approval window reachable? (read-only)
```

- Providers: `anthropic-sub`, `openai-sub` (account tokens) and `xai`, `openai` (stored API keys). For `xai` and
  `openai` the `--account` flag is optional: an account that stores a key is picked, one tagged `gate-only` first.
- Without `--pid` the asking process is unidentified: the window says so, an allow is good once, and nothing is
  remembered. `--pid` must be a plain positive integer.
- `request` is the only verb that spends anything: after you allow it, it may refresh the account's expired OAuth
  access token inside the vault, because a request is real use. The refresh token itself is never handed out.
- A Claude account without a long-lived token hands out an OAuth access token, which dies when any app refreshes the
  account. The command warns and names `tools claude login-long <account>`.
- Without `--json` or `--print-token` the token is masked (12 characters of a token, 4 of an API key).
- A denial exits 77 with its code and message.

#### `ai gate auto-allow`: the vault key with no window for agent-started commands

A `tools` command that reads the vault asks GenesisTools.app for the vault key, and the app shows a window that
confirms with Touch ID. Commands on the auto-allow list skip that window when an agent starts them, and each pass is
logged (event `auto-allowed` in `~/.genesis-tools/ai/gate/audit.jsonl`) and posts a notification.

```bash
tools ai gate auto-allow [--json]                  # the list, the agent apps, the notification switch (read-only)
tools ai gate auto-allow add claude warmup         # let "tools claude warmup" through
tools ai gate auto-allow remove claude warmup      # it no longer skips the window on this list
tools ai gate auto-allow add-agent "Grok Bot"      # count an app's processes as an agent's
tools ai gate auto-allow remove-agent "Grok Bot"
tools ai gate auto-allow notify on|off             # the audit line is written either way
tools ai gate auto-allow enable|disable            # disable: this bypass stops; the list is kept
tools ai gate revoke <tool>                        # forget remembered "Always" allows too
```

- `disable` and `remove` stop only this list. A command that was allowed with "Always" in the window is remembered
  separately (`tools ai gate grants`) and still skips the window; `tools ai gate revoke <tool>` (or `--all`) forgets it.
- Defaults: `claude warmup`, `claude usage`, `ai warmup`, `ai usage`; agent apps `Grok Bot`; notification on. The file
  is `~/.genesis-tools/ai/gate/vault-auto-allow.json`; a missing file, or a missing or null key, is the defaults. A
  file the app cannot decode (not JSON, not an object, or a key of the wrong type such as `"enabled": "false"`) turns
  the list off in the app. The CLI then prints the error with the file's path, exits 1, and changes nothing until the
  file is fixed or removed. Showing the settings only reads the file.
- `add` takes a tool and its subcommand (`claude warmup`); an empty or other-shaped command is refused.
- A request passes only when all of these hold: the program is Bun or a `gt-<tool>` launcher at their known paths
  (`~/.bun/bin/bun`, Homebrew's, `~/.genesis-tools/bin/gt-*`); the script is `src/<tool>/index.ts` of the GenesisTools
  checkout the app was built from (a worktree build counts as its main checkout); the first argument after the script
  is the subcommand (no option before it) and `<tool> <subcommand>` is on the list; a process named `claude`, `codex`
  or `grok`, or a process of a listed app, is among the caller's parent processes (a `CLAUDE_CODE_SESSION_ID` in the
  environment proves nothing); and the only variable that loads extra code is `NODE_PATH` (Grok Bot, an Electron app,
  sets it in every shell it opens). Anything else gets the window.
- The notification and the audit line's `detail` name the agent as the listed app, or the CLI's executable name and
  pid (`codex (pid 80)`), never with an argument: a CLI's first argument can be the prompt.
- Why: DECISION 57 c (2026-11-10). The command never prints the key; the window's job is to decide which program holds
  the key, and for these commands that decision is made once, here.

### `ai usage`: quota across every provider

One dashboard over every plugin that declares `accounts.usage`. The TUI is the default; `--json` and `--no-tui` never
import Ink, which is what keeps a scripted read cheap.

```bash
tools ai usage [--provider claude|codex|grok] [--account <name>] [--range 60m|6h|24h|7d] [--json|--no-tui] [--fresh]
tools ai usage daemon register [-i "every 60 seconds"] [--retention-days 3] [--retention-min 100]
tools ai usage daemon unregister|status
```

- `--provider` takes `anthropic-sub`, `claude`, `codex`, `grok`, `grok-sub` or `openai-sub`. `-f, --filter` is an
  alias of `--account`, kept for scripts. `--fresh` forces a live poll past the shared per-provider cache.
- `--scored` on the dashboard is Anthropic-only; use `tools claude usage --json --scored`, or
  `tools ai usage limits --scored` for every provider.
- `--provider` and `--range` are enumerated: passed with no value, or with a value that is not on the list, they print
  the possible ones and exit 1.

`tools claude usage`, `tools codex usage` and `tools grok usage` are the same dashboard pinned to one provider.
`tools claude usage` additionally keeps its Sessions tab, the `--token`, `--watch` and `--scored` flags, and its
`usage sessions` subcommand.

`daemon register` owns the single `ai-usage-poll` task and removes the old claude-only `claude-usage-poll` on the way
through. Running it once is the whole migration. `--retention-days` and `--retention-min` prune the run logs
together. `tools claude daemon` is an alias for the same three subcommands.

#### `ai usage limits`: windows now, over time, the forecast and the advisor

```bash
tools ai usage limits [--provider ...] [--account ...] [--cached|--fresh] [--scored] [--json]
tools ai usage limits series \
    [--since 24h] \
    [--until <when>] \
    [--tz <zone>] \
    [--step auto|raw|5m] \
    [--agg last|minmax|raw] \
    [--kind session weekly ...] \
    [--json]
tools ai usage limits forecast [--provider <id>] [--account <name>] [--json]
tools ai usage limits advise [--model fable] [--cached|--fresh] [--json]
tools ai usage limits health [--since 24h] [--provider ...] [--account ...] [--json]
```

`limits`, `limits series` and `limits advise` with `--json` print one envelope,
`{ schema: "usage.<verb>@1", generatedAt, window?, selector, data, warnings }`, from the shared contract in
`@genesiscz/utils/ai/usage/contract` (the `--since`/`--until`/`--tz` grammar, the `--account` selector, the step
default). `--since` takes a duration (`90m`, `7d`, `4w`), a date (local midnight in `--tz`), an ISO instant with an
offset, or `today`, `yesterday`, `week` (Monday start) and `month`; `--range`, `--from`, `--to`, `--hours` and
`--timezone` are hidden aliases. `--account` takes an id, a name, `provider/name` or a unique part of a name, and an
ambiguous value lists its candidates. `--cached` reads the last poll's snapshots file and never polls.
`limits forecast` is the exception: it prints `tools hub forecast`'s own `ForecastResult` with no envelope, and its
`--account` is an exact account name, not the selector.

- `limits` is every account's windows now. `--scored` adds `data.ranked`: each provider's accounts ranked by its own
  ranker (each provider's usage feature declares it as `usage.ranker`, and `rankAccounts` in
  `@genesiscz/utils/ai/usage/account-rank` reaches it; Claude's scorer, Codex and Grok the shared window ranker).
- `limits series` is the series door `/api/ai/usage/series` also reads: points or minmax bins (`--step auto` draws at
  most 720 bins), the resets, the window's availability spans (`limited`, `absent`, `unknown` for rows older than the
  column), the current value, and a forecast with the pace band and the safe pace. Window kinds: `session`,
  `weekly`, `monthly`, `scoped`, `credit`.
- `limits forecast` is an alias of `tools hub forecast`: the same flags, the same runner, the same bytes.
  `tools hub forecast` stays the real command. It reads recorded snapshots only and never fetches.
- `limits advise` names the next account per workload (`default`, `fan-out`, `long-run`, and `model:<name>` for each
  `--model`), how long it lasts at the recent burn, and the weekly capacity each account leaves unused at its reset.
- `limits health` is the poll coverage per account over the window: the current outcome (`ok`, `stale`, `error`,
  `blocked`, `backoff`, `needs-login`, or `unmeasured` when no poll reaches the present), since when, the share of the
  window some poll measured, the gaps of 5 minutes or more nobody polled, and the reading source (`endpoint`,
  `headers`, `app-server`, `billing-api`). The daemon tick writes the runs to `usage_poll_runs`, one row per account
  while its outcome stays the same. It never polls: a flat line now reads as idle, unmeasured, stale or held back.

The same answers are MCP tools under the `usage` capability of the GenesisTools MCP server (`usage_limits`,
`usage_series`, `usage_forecast`, `usage_advise`). They read the last poll's file and never poll.

#### `ai usage limits spikes`, `attribution` and `drift`: who ate the bar

```bash
tools ai usage limits spikes [--since 24h] [--min-delta 5] [--window-min 10] [--kind session] [--account ...] [--json]
tools ai usage limits attribution [--kind weekly] [--since <when>] [--account ...] [--json]
tools ai usage limits drift [--since 28d] [--kind weekly] [--min-windows 5] [--pad 5] [--record] [--json]
```

- `spikes` (`usage.limits.spikes@1`) finds every rise of a window by `--min-delta` points within `--window-min`
  minutes and lists the sessions that spent on that account in the span (5 minutes before its first reading
  included), with their main-loop and sub-agent dollars and share. Spend of the provider that no account claims is
  `unattributed (another host or a missing pin)`.
- `attribution` (`usage.limits.attribution@1`) splits each window's rise since its last reset (8 days of lookback),
  or since `--since`, by project and session, in dollars and in points of the bar at the account's dollars per point;
  unpinned spend is its own slice.
- `drift` (`usage.limits.drift@1`) measures tokens and dollars per point per account, model and ISO week over
  exclusive windows (the account's bar rose and no other account of its provider rose within `--pad` minutes), with a
  95% bootstrap interval. A week needs `--min-windows` exclusive windows for a number. A week whose interval misses
  the earlier weeks' reads `limit cut?` or `limit raised?`. `--record` writes the weeks into `limit_drift`.

Sessions reach accounts through each harness's spend driver (`MonitorDriver.sessionAccount`): Claude transcripts name
no account, so the pin journal answers (the LAST pin of a session, flagged `approximate`); Codex and Grok answer by
the account that owns the transcript's home, then by the pin. Every session row carries `next`, its
`tools ai sessions report <id>`.

#### `ai usage events`: rate limits, cooldowns and probes

```bash
tools ai usage events \
    [--since 24h] \
    [--until <when>] \
    [--tz <zone>] \
    [--kind usage-429 rate-limited cooldown poll-backoff org-blocked probe-refused probe] \
    [--provider ...] \
    [--account ...] \
    [--limit <n>] \
    [--json]
```

Facts that lived only as day-log text, newest first, as `usage.events@1` with counts per kind: the usage endpoint's
429s, the proxy's rate-limited answers and the cooldowns it took, the poll gate's pauses, organization blocks,
refused quota probes, and one row per account, model and day counting the probes sent. `recordUsageEvent`
(`@genesiscz/utils/ai/usage/events/record`) writes them where they happen and never throws; the proxy maps its
provider names to plugin ids first. `--account` matches an id or a name exactly, proxy account names included.

#### `ai usage alerts`: the alert engine

```bash
tools ai usage alerts [list] [--since 7d] [--rule ...] [--unacked] [--provider ...] [--account ...] [--json]
tools ai usage alerts ack <id...> | --all
tools ai usage alerts rules [--json]
tools ai usage alerts test <rule> [--account ...] [--send] [--json]
```

The daemon tick runs the engine after each poll round and records every alert it fires in `usage_alerts`, which is
also its dedupe memory: one alert per dedupe key per window cycle, again only when the severity rises (each rule's
`refire`). The rules (`ALERT_RULES` in `@genesiscz/utils/ai/usage/alerts/rules`):

- `threshold`: the percent thresholds the notifier used (session `[80]`, weekly `[20, 40, 60, 80]`; scoped and
  monthly windows use the weekly list).
- `predicted-exhaust`: the forecast runs a window out before its reset within its lead time (45 min for 5h, 12 h
  weekly, 6 h scoped), only while its use rose in the last 30 minutes; again in one cycle only when the run-out moves
  30 minutes earlier.
- `limit-state-change`: a window disappeared (an account lost its 5-hour limit) or came back.
- `health`: the poller recorded nothing for 10 minutes, an account is paused by the poll gate, refused by its
  organization or has no credential, a refresh grant expires within 7 days, or the probe budget refused a probe.
- `rate-limited`: 3 rate-limit answers for one account within 10 minutes.
- `budget`: a window with a budget burns more today than its allowance times 1.2 (`over pace`), or eats into its
  reserve; and "use it or lose it": a budgeted weekly or monthly window resets within 6 hours with 40% or more left
  (`useItBudgetedOnly: false` extends that to every window).

`list`, `rules` and `test` never write. `test` judges the last poll's snapshots without polling or recording, and
`--send` tries the rule's channels with its findings or one test card. The alert settings are under
[Configuration](#configuration).

#### `ai usage budgets` and `ai usage digest`

```bash
tools ai usage budgets [list] [--provider ...] [--account ...] [--json]
tools ai usage budgets set --account <name> --kind weekly|session|monthly [--reserve 15] [--daily 12]
tools ai usage budgets set --spend-daily 30 [--provider codex]
tools ai usage budgets rm --account <name> --kind weekly | --spend [--provider codex]
tools ai usage digest [--day [YYYY-MM-DD] | --week [YYYY-MM-DD]] [--tz Europe/Berlin] [--json | --md | --write]
```

- `budgets set --reserve <pct>` keeps that share of the window at its reset; `--daily <pct>` uses at most that share
  per local day; `--spend-daily <usd>` is a dollar target per local day. `list` (`usage.budgets@1`) shows each
  budgeted window's pace today (the allowance spreads what is left above the reserve over the days to the reset) and
  each spend target against today's spend. The `budget` alert rule reads the same keys.
- The daemon tick rolls yesterday and today into `usage_daily` at most every 15 minutes: one row per account, window
  and local day with its first, last and highest reading, its resets, the cycles that reached 90% and the minutes
  measured. The rows outlive the prune of `usage_snapshots` (`dataRetentionDays`, default 30).
- `digest` (`usage.digest@1`) folds one day (default yesterday) or one Monday-to-Sunday week (default last week) into
  limits per account (an absent window reads "no limit since"), spend by provider and model with the five costliest
  sessions, worker cost by backend, the alerts that fired, and the windows forecast to run out before their reset.
  The text output is the markdown note (`--md` asks for it by name); `--write` puts it into the hub digest folder
  (`tools hub digest config --folder`) and prints its path.

#### `ai usage sessions`: one list across Claude, Codex and Grok

```bash
tools ai usage sessions \
    [--provider claude|codex|grok] \
    [--hours <n>] \
    [--min <n>] \
    [--limit <n>] \
    [--json] \
    [--fresh] \
    [--cost]
```

- With no flags it lists every session of every provider, newest first. `--provider` takes one or more names.
- `--hours` keeps sessions touched in the last N hours. `--min` tops up with older sessions until at least N rows
  (Claude only). `--limit` caps the rows, newest first across every provider.
- `--cost` adds `spentUsd` (the list-price dollars of the session's calls), `usdPerHour` (its calls of the last hour)
  and `coldRebuildUsd` (what the next prompt costs extra when the cache expired first: the context at the write rate
  of its tier minus the read rate) to each row. It reads each listed transcript, so it is opt-in; without it the rows
  keep their bytes.
- `--no-cache-write` reads the rows without updating the daemon cache or its request stamp. `--journal-only` leaves
  out the live cmux tab of tmux-hosted sessions, for rows that will be cached. Both apply to `--json` only.

Computing the list walks every native session home and stats about 12,000 files, which costs ~1.8 s of CPU.
Genesis.app asks for the same list every 35 seconds, so `--json` reads a resident answer at
`~/.genesis-tools/ai/usage-sessions.json` when it is under 90 seconds old and answers the same query:
**0.22 s of CPU instead of 1.8 s**, with byte-identical rows.

The `ai-usage-poll` tick recomputes that file once a minute, so a poller on any cadence finds it warm. The tick
refreshes only the query the CLI last asked for, and only while something has asked within the hour, so an idle
machine pays nothing.

- The payload carries `fetchedAt` (when the rows were computed, not when you asked) and `cached: true|false`, so a
  consumer can judge the age itself.
- `--json --fresh` recomputes and rewrites the file. Without `--json`, `--fresh` renders an uncached table and does
  not write.
- The human table is never served from the cache.

#### `ai usage spend`: the `tools ai-spend` tree

`tools ai usage spend <verb> ...` is an alias of [`tools ai-spend <verb> ...`](../ai-spend/README.md): the same
commands, flags and bytes. `tools ai-spend` stays the documented path, and a new spend verb lands in its tree.

```bash
tools ai usage spend                          # summary for the last 30 days (default verb)
tools ai usage spend sessions --top 10        # the most expensive sessions
tools ai usage spend daily --since 2026-11-01 # by day; also weekly, monthly, session, blocks, today
tools ai usage spend monitor                  # today, yesterday, this week and last 7 days in under a second
```

The tree also has `series`, `workers`, `pivot`, `plans` (with `plans price`), `proxy`, `waste`, `statusline`, and one
group per harness (`claude`, `codex`, `opencode`, `amp`, `droid`, `codebuff`, `hermes`, `pi`, `goose`, `kilo`,
`copilot`, `gemini`, `kimi`, `qwen`, `openclaw`, `grok`, `jev`). `--harness <list>` picks transcript data by the
agent that wrote it (`--sources` and `--backend` are the older names); a limits verb refuses `--harness`, because
limit windows belong to a provider (`--provider`).

### `ai sessions`: replay and report one session

```bash
tools ai sessions tail <session-id> [-f] [--format compact|json|jsonl|events|raw] [--limit 80]
tools ai sessions grep <session-id> <query> [--limit 500] [--json]
tools ai sessions subagents [session-id] [--json]
tools ai sessions subagents --all [--since 24h] [--limit <n>] [--session <id>] [--agent <id>]
tools ai sessions report <session-id> [--provider claude|codex|grok] [--top 10] [--json]
```

- Every verb takes `--provider claude|grok|codex`; without it the provider is detected.
- `tail` prints a session as unified turns. The id may also be a worker name. `--thoughts none|short|full` sets how
  much reasoning the compact and events formats show. `--json` is `--format json` (the Genesis Session Details
  envelope). `--offset <n>` starts at a turn (default: the last `--limit` turns), and `--turns 3,17,902` prints exactly
  those 0-based turns. `-f` follows the file until Ctrl-C. `--live` is the app form of follow: each turn as a JSON
  line with its `index`, again whenever it changes, a totals line, and an activity line (thinking, tool, waiting,
  idle, interrupted) whenever that changes; it runs until stdin closes.
- `grep` finds the turns of the whole session that show the query (case-insensitive). `--json` prints
  `{ sessionId, total, turns, truncated }`; `total` counts every match even past `--limit`.
- `subagents` lists a Claude session's sub-agents and teammates and whether each still works. `--all` lists every
  recent session's tree with Codex and Grok workers included (the same as `tools hub agents`); `--agent` prints one
  agent with its whole spawn prompt.
- `report` reads the session's `analysis` facts through its reader (`NativeSessionReader.analysis`: `callTrace`,
  `compactions`, `quotaReadings`), so Claude, Codex and Grok answer the same shape: cost by model and by main loop and
  sub-agents, the cost without any cache and the savings, the quota weight (cache reads count a tenth), the costliest
  calls with their tags (`cold-cache`, `partial-cold`, `large-cache-write`, `high-output`, `subagent`), the cache
  losses with their cause, and the longest gaps. A fact a harness does not record is listed under `unsupported` with
  its reason. `--json` prints `{ schema: "sessions.report@1", session, report }`.

### `ai sessions workflows`: a session's Workflow tool runs

```bash
tools ai sessions workflows list [session-id] [--json]
tools ai sessions workflows show <session-id> <run> [--usage] [--json]
tools ai sessions workflows grep <session-id> <pattern> [--run <run>] [-i] [--before <iso>] [--max-hits 3] [--context 100] [--json]
tools ai sessions workflows result <session-id> <run> <agent>
```

- Claude Code's Workflow tool keeps a run's agents outside the session's direct sub-agents: `<session>/subagents/workflows/<runId>/` holds their transcripts and a journal, and `<session>/workflows/<runId>.json` holds the run record. `subagents` lists them after the direct agents, grouped by run, each with its label, phase, model and state. Its `--json` adds `workflow: { runId, label, phase }` to each such agent, a `workflowRuns` list (name, status, start, duration, agents, results) and `workflowReader`.
- One agent id is one row. A workflow agent that the lead revives with SendMessage writes a second transcript directly in the sub-agent folder; the row keeps both in `files` (oldest first), `filePath` is the newest, and the run, label and phase come from the first.
- `workflows` reads the runs through the session's reader (`NativeSessionReader.workflows`). It joins a run's agents by id from the run record, the journal and the transcript folder, and keeps which source named each one, because the three disagree: a killed run has transcripts and few results, and a run stopped before its end has transcripts and no record. `<run>` is a run id prefix or a workflow name.
- `show --usage` reads every agent transcript for its calls, tokens and list-price cost. The run record's own token total is far lower and is printed as recorded, not recomputed.
- `grep` says for each hit whether the agent wrote the text (`assistant`), was shown it (`tool-result`) or was told it (`prompt`). `result` prints an agent's final structured answer from the journal.
- Codex and Grok have no workflow tool. `workflows list` with no session names each provider's reader, and a session of theirs answers `no workflow reader` with the reason, never "0 runs".

### `ai statusline`: the coding-agent statusline

```bash
tools ai statusline preview [--plain] [--json]     # a sample from this checkout's newest transcript
tools ai statusline configure                      # interactive setup with a live preview (needs a TTY)
tools ai statusline install [--via-tools]          # make the host run it; the old command is kept
tools ai statusline uninstall                      # put the previous command back
tools ai statusline status                         # what the host runs now and where the config lives
tools ai statusline run [--stdin-file <path>] [--columns <n>] [--timings]   # what the host runs per refresh
```

- Every verb takes `--claude` (default), `--codex` or `--grok`. Only Claude Code has a statusline hook today; the
  other two fail with that message.
- `install` writes the command into Claude Code's `settings.json` (the real file when it is a symlink), keeps the
  previous file as a `.bak` copy beside it, and remembers the previous command for `uninstall`. By default it
  installs a direct hot entry at `~/.genesis-tools/ai/statusline/run.ts`, which skips the whole command tree;
  `--via-tools` installs the `tools ai statusline run` form instead. `uninstall` does nothing when the installed
  command is not ours.
- `preview` renders with synthetic context usage, an isolated cache and the token delta turned off.

### `ai tokens`: count and compare tokens

```bash
tools ai tokens count README.md notes.txt              # tokens and characters per token, per input
cat draft.md | tools ai tokens count -                 # stdin
tools ai tokens compare a.json a.toon --slice 4000     # rank inputs by density over an equal slice
```

- `--method estimate|gpt3-bpe|claude-local|claude-api` (default `claude-local`). Every method except `claude-api`
  runs locally.
- `--method claude-api` calls the Anthropic `count_tokens` endpoint with `--model` (default `claude-opus-5-5`, the
  current Opus). It needs `ANTHROPIC_API_KEY`. Subscription accounts are deliberately not used, because binding one
  can rotate a single-use refresh token.
- `--json` prints `{ method, model, slice, counts }`.

### `ai cmux tree`: agents in the terminal multiplexer

```bash
tools ai cmux tree [--provider claude,codex,grok] [--json]
```

The live cmux hierarchy with the Claude, Codex or Grok session in each surface and the pane frames. It exits 1 when
cmux is not reachable.

### `ai warmup`: start a session timer on every account

```bash
tools ai warmup                       # pick accounts (TTY)
tools ai warmup --all [--provider codex] [--json]
tools ai warmup personal cdx-work     # by name or id, any provider
```

One tiny request per account (five output tokens, on the smallest model where the provider lets a ChatGPT-style
account pick one; codex accounts reject a pinned slug, so they use the account's default model), so a rolling window
starts now instead of on the first real call. An Anthropic account without a 5-hour limit has no session timer: it is
skipped when its weekly window already runs, and the daemon's session warmup never sends to it. The selection, the
send and the report live in `@genesiscz/utils/ai/warmup`; `tools claude warmup`, `tools codex warmup` and
`tools grok warmup` are the same command pinned to one provider, and the usage daemon's scheduled warmups call the
same function.

Anthropic falls back to a long-lived (`tools claude login-long`) token when the OAuth grant is dead and reports
`used login-long token`. Codex goes through the ChatGPT backend, which only streams and accepts only the account's own
model list, so the codex warmup always uses the account's default model. Exit code 1 when any account failed; the
failing line carries the vendor's message and the re-login command.

## How it works

### How credentials are stored

Nothing sensitive is in the config file. Accounts hold **references** into an AES-256-GCM vault at
`~/.genesis-tools/security/vault.json`, with a per-entry key derived by HKDF. The master key is resolved from a
ladder, first hit wins: the `GENESIS_TOOLS_MASTER_KEY` environment variable, then GenesisTools.app's approval window
(when the app is installed), then the OS keychain, then an opt-in key file. With the app installed, a vault read can
show the app's approval window. A deny there stops the read: it does not fall through to a keychain key on the same
Mac. When the app cannot answer, the keychain rung answers instead.

Config itself lives at `~/.genesis-tools/ai/config.json`. It is re-read when its mtime changes, so a long-running
proxy notices a login performed in another terminal.

### Model references

The resolution ladder accepts several forms, most specific first:

```
grok-4-fast                  # bare model id
xai/grok-4-fast              # provider-qualified
@account/<id>                # an account with its default model
@account/<id>:<model>        # a specific account and model
@proxy/<slug>/<model>        # via tools ai-proxy
```

When nothing is specified, the ladder falls back to the app default, then the task default, then the global default.
`tools ai-proxy link` registers a local proxy as a real account, which is what makes `@proxy/...` references resolve
here.

### Where data lives

| Path | What |
|------|------|
| `~/.genesis-tools/ai/config.json` | accounts, defaults, aliases |
| `~/.genesis-tools/security/vault.json` | the encrypted credential vault |
| `~/.genesis-tools/ai/gate/` | `grants.json`, `vault-grants.json`, `vault-auto-allow.json`, `audit.jsonl` |
| `~/.genesis-tools/ai/statusline/` | `config.json` and the installed `run.ts` |
| `~/.genesis-tools/ai/usage-sessions.json` | the cached `usage sessions --json` answer |
| `~/.genesis-tools/ai-usage/cache/` | the last poll's snapshots, poll gates, daemon heartbeat |
| `~/.genesis-tools/ai-usage-dashboard/config.json` | alerts, notifications, budgets, retention |
| `~/.genesis-tools/claude-history/index.db` | usage tables (see below) and agent history |
| `~/.cache/huggingface/hub` | downloaded local models |

The usage tables in `index.db` are `usage_snapshots`, `spend_snapshots`, `usage_poll_runs`, `usage_events`,
`usage_alerts`, `usage_alert_cursor`, `usage_window_cycles`, `usage_daily` and `limit_drift`. Each daemon tick prunes
`usage_snapshots`, `spend_snapshots`, `usage_poll_runs`, `usage_events` and `usage_alerts` to the last
`dataRetentionDays` days (default 30). `usage_daily`, `usage_window_cycles` and `limit_drift` are kept. 🛑 The same
file holds the Claude, Codex and Grok history index; never delete it as a cache.

### What it calls and what costs money

- `translate`, `summarize`, `classify` and the local models run on the Mac when a local provider answers. A cloud
  provider bills the account it resolves. Cost of calls made through this subsystem is recorded automatically; see
  `tools ask usage` for `ask` analytics and [`tools ai-spend`](../ai-spend/README.md) for coding-agent session spend.
- `image` calls the Hugging Face inference API.
- `ai usage` polls each provider's usage endpoint (or reads headers and app-server answers). `--cached`, `forecast`,
  `health` and the MCP tools never poll.
- `warmup` sends real requests (five output tokens each). `gate request` may refresh an OAuth access token.
- `tokens count --method claude-api` calls the Anthropic API.
- `gate` needs GenesisTools.app for the approval window; `gate status` says whether it is reachable. The alert
  `macos` channel posts a notification through the app, and the `inbox` channel writes a card into the GenesisTools
  widget.

## Configuration

- **Accounts and defaults**: `tools ai config` (interactive) or its subcommands. Write the config only through these
  commands; the store re-reads on mtime change and serializes writes under a lock.
- **Environment variables**:
  - `GENESIS_TOOLS_MASTER_KEY`: the vault master key, the first rung of the ladder.
  - `HUGGINGFACE_TOKEN` (or `HF_TOKEN`): the token for `image`, read when the deprecated config facade holds none for
    a `huggingface` account. `image` is the one verb that does not resolve through the account ladder.
  - `ANTHROPIC_API_KEY`: only for `tokens --method claude-api`.
  - `HF_HOME`: moves the Hugging Face model cache.
  - An account may fall back to the env vars named in its `--use-env` policy.
- **Alerts** live in `~/.genesis-tools/ai-usage-dashboard/config.json` under `alerts`, nested by axis:
  `alerts.global` (`enabled`, `quietHours: { start, end }`), `alerts.rules.<rule>` (`enabled`, `channels`, and the
  rule's own keys), and `alerts.providers.<plugin id>.rules.<rule>.enabled` to turn one rule off for one provider.
  The channels are `macos` (a banner; it honours `notifications.macos` and `notifications.sound`, and quiet hours hold
  it) and `inbox` (an unread card in the GenesisTools widget). Defaults: threshold to `macos`, predicted-exhaust to
  both, limit-state-change, rate-limited and budget to `inbox`, health recorded only. `alerts.global` defaults to
  `enabled: true` and `quietHours: null`. Each rule is on by default, and its own keys default to:
  - `threshold`: `session` `[80]`, `weekly` `[20, 40, 60, 80]`.
  - `predicted-exhaust`: `leadMinutes` `{ session: 45, weekly: 720, scoped: 360 }`, `requireActive` true,
    `activeMinutes` 30.
  - `health`: `downMinutes` 10, `refreshExpiryDays` 7.
  - `rate-limited`: `count` 3, `windowMinutes` 10.
  - `budget`: `overPaceFactor` 1.2, `useItHours` 6, `useItMinLeftPct` 40, `useItBudgetedOnly` true.

  `tools ai usage alerts rules` prints the settings in force. The loader moves the old `notifications.thresholds` to
  `alerts.rules.threshold` once; a read-only load migrates in memory and writes nothing. On its first tick the engine
  seeds its record from the old notifier's trackers, so no threshold already announced fires again.
- **Budgets** live in the same file under `budgets`, nested by axis: `budgets.global.spend.dailyUsd`, then
  `budgets.providers.<plugin id>.spend.dailyUsd` and
  `budgets.providers.<plugin id>.accounts.<account id>.<kind>.{ reservePct, dailyAllowancePct }`. A missing key is no
  budget. Set them with `tools ai usage budgets set`.
- **Retention and pace**, in the same file: `dataRetentionDays` (30) is how many days the daemon keeps the pruned
  usage tables (see [Where data lives](#where-data-lives)). `paceScope` (`"pooled"`) sets whose history the "at pace"
  estimate reads: `pooled` reads the samples of every account, and `per-account` reads only the account in question.
- **Statusline**: `~/.genesis-tools/ai/statusline/config.json`, edited by `tools ai statusline configure`. Keys and
  defaults: `showDelta` (true), `showSession` (true), `showAccount` (true), `showGit` (true), `showDirty` (false),
  `modelStyle` (`"id"`, or `"short"`), `graft` (`enabled` true, `shim` the `helpers/graft-statusline.cjs` file in the
  Claude home, `ttlMs` 10000), `metricsPost` (`enabled` false, `url` `http://localhost:8765/statusline`, `timeoutMs`
  300), `gitTtlMs` (5000), `extends` (null; wrap another statusline script and place its lines before or after ours),
  `fallbackColumns` (80), `previousCommand` (written by `install`).

## For agents

- **JSON**: almost every read verb takes `--json`. The usage verbs print a versioned envelope named in their help
  (`usage.limits@1`, `usage.limits.series@1`, `usage.limits.advise@1`, `usage.limits.health@1`,
  `usage.limits.spikes@1`, `usage.limits.attribution@1`, `usage.limits.drift@1`, `usage.events@1`, `usage.alerts@1`,
  `usage.alerts.rules@1`, `usage.budgets@1`, `usage.digest@1`); `sessions report --json` prints
  `sessions.report@1`. `limits forecast --json` prints the hub's `ForecastResult` without an envelope.
- **Exit codes**: 1 for a usage error (an unknown enumerated value prints the allowed ones), for `warmup` when any
  account failed, for `cmux tree` when cmux is not reachable, and for an interactive command (`config`,
  `statusline configure`) without a TTY. `gate request` exits 77 when the approval is denied.
- **Prompts**: enumerated flags such as `--provider` prompt in a TTY. In a pipe, pass every value.
- **MCP**: the GenesisTools MCP server exposes `usage_limits`, `usage_series`, `usage_forecast` and `usage_advise`
  under the `usage` capability. They read the last poll's file and never poll.
- **Skills**: the `handoff-to` plugin skill reads a worker's turns with `tools ai sessions tail`, and names
  `tools ai accounts login` and `tools ai codex login` as doors onto the one login core.

### 🛑 Diagnostics do not mutate

`doctor`, `account test`, `accounts list`, `accounts show`, `accounts discover` (without `--bind`) and `accounts who`
are read-only by contract. They resolve and report, and they refuse to spend a single-use credential. The same holds
for `gate grants`, `gate audit`, `gate status`, `usage alerts list|rules|test` and `usage limits --cached`.

This is not a stylistic preference. Both `doctor` and `account test` once rotated Anthropic OAuth refresh tokens simply
by reaching a shared auth path that refreshed on expiry, which meant **diagnosing an account could break it**. The
guard now lives in the shared function, immediately before the call that spends the token, rather than at each call
site. `doctor --live` and `account test --live` add the plugin's health probe, which may touch the network.

## Troubleshooting

- **`--provider` on `classify` changes nothing.** The flag is ignored (see Text verbs). `classify` has no
  workaround: it always runs the macOS classification helper, and it reads no task default, account or model.
- **`image` says "Hugging Face token required".** Export `HUGGINGFACE_TOKEN` (or `HF_TOKEN`).
- **`tokens --method claude-api` fails at once.** It needs `ANTHROPIC_API_KEY`; it never borrows a subscription
  account.
- **`tools ai config` exits 1 in a script.** With no subcommand it is an interactive menu; call a subcommand.
- **A command prints a list of allowed values and exits 1.** An enumerated flag got no value or an unknown one in a
  pipe. Pass one of the printed values.
- **`ai usage` shows a flat line.** Run `tools ai usage limits health`: it tells idle from unmeasured, stale, held back
  or blocked, and lists the gaps nobody polled. `tools ai usage daemon status` shows whether the poller runs.
- **`gate request` never shows a window.** Run `tools ai gate status`; the approval window needs GenesisTools.app.
- **A gate approval is never remembered.** Pass `--pid`. Without it an allow is good once.

## Related

- [`tools ai-spend`](../ai-spend/README.md): coding-agent token and cost analytics (`ai usage spend` is its alias).
- [`tools ai-proxy`](../ai-proxy/README.md): the local proxy; `tools ai-proxy link` makes `@proxy/...` refs resolve.
- [`tools claude`](../claude/README.md), [`tools codex`](../codex/README.md), [`tools grok`](../grok/README.md):
  login, usage and warmup doors pinned to one provider.
- [`tools ask`](../ask/README.md): chat on the same accounts; `tools ask usage` for its analytics.
- [`tools hub`](../hub/README.md): `hub forecast`, `hub agents` and the digest folder.
- [`tools say`](../say/README.md): asks the gate for an API key.
- [`tools daemon`](../daemon/README.md): runs the `ai-usage-poll` task.
- [`tools cmux`](../cmux/README.md): the terminal multiplexer behind `ai cmux tree`.

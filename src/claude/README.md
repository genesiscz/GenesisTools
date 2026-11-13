# tools claude

`tools claude` runs and manages Claude Code on a Mac with several Claude accounts, for when one keychain login is
not enough or a script or another agent must reach a Claude session. It launches Claude Code pinned to one account
(or on a Codex or ai-proxy model), keeps the account logins and their usage limits, searches and resumes past
sessions, talks to running sessions, drives headless workers, and rebuilds a set of sessions as cmux panes after a
crash.

`tools cc` is a short alias that defaults to `resume` (see [`../cc/README.md`](../cc/README.md)).

## Quick start

```bash
tools claude login work                    # add an account with OAuth (usage polling, auto-refresh)
tools claude login-long work               # attach the long-lived token that launches use
tools claude start work                    # launch Claude Code pinned to that account (alias: run)
tools claude start auto --resume "parser"  # best account by headroom, resume a session by search
tools claude usage                         # usage dashboard for every account
tools claude history "auth callback"       # search past conversations in this project
```

## Commands

Run `tools claude <command> --help` for the full flag list of any command below.

### Launch Claude Code

| Command | What it does |
|---|---|
| `start\|run [name]` | Launch Claude Code with an account's long-lived token |
| `proxy [target]` | Launch Claude Code on a model served by ai-proxy |
| `codex [account]` | Claude Code with its main loop on a Codex model |
| `embed [account]` | Be the `claude` binary for an app that embeds it (T3 Code) |
| `exec [-a <account>] -- <cmd>` | Run any command with an account's token in its env |
| `teams` | List agent teams and re-attach teammates with OAuth |

### Accounts and usage

| Command | What it does |
|---|---|
| `login [name]` | Add an account with OAuth (auto-refresh, usage polling) |
| `login-long [name]` | Attach a long-lived token (`--setup-token` mints it here) |
| `login-secondary [name]` | Store a second OAuth grant, used by `start --keychain` |
| `logout [name]` | Remove an account's tokens (flags pick which, see below) |
| `config` | Interactive menu: accounts, notifications, auto-warmup |
| `config add <name> --token <t>` | Add an account with a manual access token |
| `config remove <name>` | Remove an account |
| `config rename <old> [new]` | Rename an account with its history (`--to` when not a TTY) |
| `config refresh [name]` | Re-read the subscription plan from the OAuth profile |
| `config show` | Print the configuration |
| `config cross-messages [accept\|hold]` | Show or set `launch.crossSessionInbound` |
| `info [name]` | Account info and cached usage, no network (`--format text\|json`) |
| `usage` | Usage dashboard (TUI); `usage sessions` lists 1-hour cache state |
| `warmup [account...]` | One tiny request per account to start its session timer |
| `anchor [name] [date]` | Show or correct the billing-day anchor (`--clear`) |
| `doctor` | Find running pinned sessions that bill the keychain account |
| `who\|active` | Live claude processes, their account, session and cmux tab |
| `daemon register\|unregister\|status` | Background usage polling (`tools ai usage daemon`) |
| `spending` | Token and cost analytics (alias of `tools ai-spend`) |

### History and transcripts

| Command | What it does |
|---|---|
| `history [query]` | Search conversation history (this project unless `--all`) |
| `history index [sync\|rebuild\|status]` | Maintain the shared history index |
| `history extract-shell-quirks` | Report zsh and bash quirk incidents from transcripts |
| `history dashboard <action>` | The history web dashboard (`up`, `down`, `open`, ...) |
| `resume [query]` | Resume a session by short id, name, or content search |
| `tail [query]` | Live-tail a session or a subagent |
| `export <session-id>` | Export a session (`-f full\|mini\|raw`, `-o <path>`) |
| `transcript <session-id>` | A session as JSON turns, for the Genesis Session Details window |
| `summarize [session-id]` | Summarize a session with an LLM template |
| `memory path\|show\|grep\|append` | Read and append the project's `MEMORY.md` |

### Running sessions

| Command | What it does |
|---|---|
| `wait <session>` | Block until the session's current turn ends |
| `message <session> [text...]` | Send a message into a running session by its own channel |
| `queue` | Durable messages for an exact session (`list`, `offer`, `ack`, `cancel`) |
| `decide` | Type one DECISION answer into the session's cmux pane; `decide links` |
| `cmux [restore]` | Rebuild recent sessions as cmux panes (`restore` is the default) |
| `cmux focus\|find\|read\|send <session>` | Reach the pane a session already runs in |
| `cmux snapshot\|list\|forget` | Named session sets for crash recovery |
| `cmux pins\|tree\|open-session` | Account pins, the live cmux tree, resume at a cmux level |

### Headless workers

| Command | What it does |
|---|---|
| `worker spawn` | Turn 1 of a new `claude -p` session pinned to an account (blocks) |
| `worker steer` | The next instruction to an existing worker (blocks) |
| `worker read` | Re-print a finished turn (`--turn`, `--format`) |
| `worker tail` | Follow the running turn; exits when it ends |
| `worker status` / `worker sessions` | Turn state and cwd / list every worker |
| `worker stop` / `worker interrupt` | End the running turn; the session survives |

### Other

| Command | What it does |
|---|---|
| `desktop` | Copy skills from `~/.claude/skills/` into Claude Desktop |
| `code versions\|unpack\|diff\|bisect` | Unpack, diff and bisect published Claude Code bundles |
| `migrate-to codex` | Wizard that moves skills, commands and `CLAUDE.md` to Codex |
| `mcp` / `mcp install` | Run or register the genesis-tools MCP server |

## Launching Claude Code

### `start` (alias `run`)

`tools claude start [name] [options] [-- <claude args>]` launches Claude Code with the account's long-lived
token in `CLAUDE_CODE_OAUTH_TOKEN`. `[name]` matches an account name exactly or as a substring, and a TTY asks
when several match. `auto` picks the account with the most headroom, like `--autopick`. Everything after `--`
goes to `claude` unchanged.

| Flag | Effect |
|---|---|
| `--pick` | Pick from a usage-ranked list, best first, with reasons |
| `-a, --autopick` | Pick the best account by usage headroom |
| `-m, --model <spec>` | Alias or substring filter (`fable`, `opus`, `4.8 1m`) |
| `-e, --effort <level>` | Claude Code's `--effort`, or the `:<effort>` suffix for a proxy target |
| `-r, --resume [query]` | Bare: this folder's sessions; a query searches |
| `-c, --continue` | Continue the most recent session |
| `--keychain` | Run on the account's secondary login, put into the macOS keychain |
| `--cmux` | Launch through `cmux claude-teams` (agent teams, tmux shim) |
| `--tmux` | Launch inside a new tmux session |
| `--sdk` | Act as the `claude` binary for an embedding app |
| `--cross-messages` | Accept messages from other sessions without approval |
| `--no-cross-messages` | Pass no accept setting; Claude Code's own settings decide |

- **`opus` and `fable` are smart names.** `tools claude start opus` spends leftovers: it prefers an account whose
  Fable bucket is gone, needs a floor of weekly headroom (10%), and takes the emptiest account above it.
  `tools claude start fable` takes the account with the most room, and inside a band of the best it takes the one
  that resets soonest. Neither blocks a launch: when nothing qualifies you get the normal picker, and an `opus`
  pick below the floor launches with a warning. A real account with that name wins. Each name also launches that
  model (the Opus or the Fable option); an explicit `--model` wins.
- **An account with no weekly quota left is refused.** `start` exits 1 and names the accounts that still have
  weekly headroom, because every model gets a 429 on such an account. The check reads the usage cache only, so a
  cache miss lets the launch go.
- **The Fable-headroom guard.** When the account's Fable weekly bucket is spent (3% or less left), an interactive
  launch with no `--model` warns, names the accounts with Fable headroom, and asks "Launch anyway?" (No exits
  without a launch). An explicit Fable model (`--model fable` or `start fable`) only warns. Another model, a resume
  or `--continue`, and a non-interactive run skip the check.
- **The resume picker is shared.** In a terminal, `tools claude resume`, `start|run --resume` (bare or with a
  query) and `tools claude codex --resume` use one picker. A session that already runs in a cmux tab is listed on
  top as live, and Enter on it focuses that tab instead of starting a second Claude process on it.
- **`--tmux`** works for Anthropic accounts. On `--resume <query>` the tmux session is named from the conversation
  title. Inside tmux already (a ttyd tab), it renames the current session and the bound ttyd tab instead of
  nesting. A slash target (`account/provider`) goes to `proxy` and ignores `--tmux`. `--tmux --keychain` cannot be
  combined with `-p`/`--print`: the detached session would race the keychain restore.
- **`--cmux`** adds `--dangerously-skip-permissions` to match the shell wrapper cmux bypasses, unless you pass your
  own permission flag.
- **`--keychain`** injects the account's secondary login (from `login-secondary`) into the keychain for the
  session. Rotated tokens sync back to the account on exit. A login in the keychain that no configured secondary
  matches (probably a direct `/login`) is backed up and restored after the session when you confirm; a
  non-interactive run refuses. An unreadable keychain login is always refused, and the keychain stays untouched.
- **Agent teams keep the account.** Claude Code passes only an allowlist of variables to tmux teammates, and
  `CLAUDE_CODE_OAUTH_TOKEN` is not on it, so teammates came up "Not logged in". `start` points
  `CLAUDE_CODE_TEAMMATE_COMMAND` at a per-process wrapper (mode 700) under
  `~/.genesis-tools/claude/teammate-wrappers/` that carries the lead's launch env.
- The launched process carries `TOOLS_CLAUDE_ACCOUNT` and `TOOLS_CLAUDE_AUTH` (`token` or `keychain`), which the
  status line, `who`, `doctor` and the account pin hook read.

### `proxy`: Claude Code on a proxied model

Launches Claude Code against a model served by `tools ai-proxy` (Grok, GitHub Copilot, OpenRouter, xAI) instead
of api.anthropic.com. The proxy answers the Anthropic Messages API natively; see
[`../ai-proxy/README.md`](../ai-proxy/README.md) for the translation.

```bash
tools claude proxy work/grok -m 4.5        # <account>/<provider> plus a model filter
tools claude proxy work/xai/grok-4.6       # or a full proxy model id
tools claude run work/grok -m 4.5          # `run` routes here when the name has a slash
tools claude proxy work/grok --list        # list matching models, launch nothing
tools claude proxy work/grok -- -c         # args after -- go to claude
```

- `[target]` is an `<account>/<provider>` prefix or a full proxy id. `-m/--model` filters inside it, and every
  whitespace-separated token must appear, so `-m "composer fast"` works. Several matches open a picker in a TTY
  and fail with the list otherwise.
- `-e/--effort` takes `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra` and appends the `:<effort>`
  suffix. Claude Code's own `/effort` also reaches the upstream.
- A **full id on a known account launches even when the catalog does not list it**, with a warning. The proxy
  advertises a curated list but routes any id whose account exists, so `work/grok/grok-4.6` answered chat while
  `ai-proxy models` still hid it. A typo in the account or provider segment still fails locally rather than
  becoming an upstream 404.
- The proxy is started when it does not answer; `--no-start` makes that an error.
- The launch clears `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from the child environment. Either one would
  outrank the proxy token and silently bill the real Anthropic account.
- The split between `start` and `proxy` is the slash: no Anthropic account name has one, and every ai-proxy target
  does.

### `codex`: Claude Code with its main loop on a Codex model

```bash
tools claude codex                            # auto Codex login, auto Claude login, sol at high
tools claude codex cdx-work -m astra -e xhigh # a named Codex login, another model and effort
tools claude codex --claude none              # no Claude account: Claude models are refused
tools claude codex --grok auto                # grok/<model> ids work in the session too
tools claude codex --resume "the parser bug"  # resume: same session id, same subagents, a fresh key
tools claude codex -- -p "one turn"           # args after -- go to claude
```

The main loop runs on `codex/<model>` through ai-proxy (`-m`: `sol` by default, `sol6`, `astra`, `terra`, `luna`,
or a catalog id; `-e`: `high` by default). Titles and the Claude-side calls run on the Claude account. The session
gets one subagent per Codex model (`sol`, `sol-xhigh`, `sol6`, `astra`, `terra`, `luna`), `opus` (and `fable` when
the Claude account has it) on the Claude account, and `codex-worker`, which hands a task to `tools codex spawn`.
Each launch writes a session record (`~/.genesis-tools/ai-proxy/sessions/<Claude Code session id>.json`) and gives
Claude Code its own `gts_` key. The proxy then routes `codex/<id>`, `grok/<id>` and bare `claude-*` ids to that
session's accounts only.

- **Accounts.** `[account]`, `--claude` and `--grok` take a login (a `tools codex`, `tools claude` or `tools grok`
  account) or a configured ai-proxy account. A login gets an account the proxy builds in memory; nothing is written
  to the proxy config. A configured account named on the command line keeps its own settings, so the legacy Codex
  account that reads `~/.codex/auth.json` still works. `auto` (the default) ranks the logins by usage and prints
  the runner-up.
- **Billed accounts.** Subscriptions only by default. An account billed per token needs `--allow-metered <account>`
  (repeatable) or a yes at a prompt (no default yes). A non-interactive launch without the flag stops before
  anything starts.
- **Errors, not failover.** The session never moves to another account by itself. A usage limit, a dead login or a
  rate limit shows in Claude Code with the account, the reset time and the command that switches:
  `tools ai-proxy session <id> use --codex <account>` (also `--claude`, `--grok`; without a flag it lists the
  accounts). The next turn runs on the new account with no restart; the status line keeps the launch's names.
- **`/model` stays in the session.** Claude Code saves a `/model` pick into the shared `~/.claude/settings.json`,
  where every other session would read `codex/…` as its default and fail. While the session runs, the launcher puts
  the file's launch-time `model` back whenever a `codex/` or `grok/` id lands there; the session keeps its pick.
- **Window.** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and the compact window are the model's usable tokens from the Codex
  catalog, passed in `--settings` too, because the `env` of `~/.claude/settings.json` would otherwise win.
  `-c, --compact <percent>` changes the compact percent. The `/model` picker lists only models whose usable window
  covers this limit; launch a fresh session to use a smaller model. A custom `--settings` after `--` can change the
  limit, so picker entries are disabled when the limit is unknown.
- **`--isolated`** uses its own Claude Code config folder under `~/.genesis-tools/claude-codex/config/<session id>/`
  and writes the subagents there as files.
- **`--port`** aims at another ai-proxy (a second one for tests); it is never started for you. `--no-start` fails
  when the proxy is not running.

### Apps that embed Claude Code: `--sdk` and `embed`

An app such as T3 Code or an Agent SDK host asks for the path of a `claude` binary and spawns it with stream-json
arguments. Give it a wrapper script that holds no token, with the absolute path of `tools` (the app's PATH may not
have it):

```sh
#!/bin/zsh
exec /path/to/GenesisTools/tools claude run --autopick --sdk -- "$@"
```

`--sdk` runs the real executable with no interactive shell between. A shell function that adds
`--dangerously-skip-permissions` would override the permission mode the app chose. It also passes the app's stop
signals on to claude, so a stopped session does not keep running. `--autopick` picks the account with the most
headroom on every spawn; give an account name to pin one.

`tools claude embed [account] -- "$@"` is the same for T3 Code launchers. The account comes from the operand
before `--`, else from `TOOLS_CLAUDE_EMBED_ACCOUNT` (set per T3 provider instance): an account name, `auto`, or
`proxy:<account>/<provider>`. The child carries `TOOLS_CLAUDE_ACCOUNT`, so `tools claude who` names its account,
and a T3 child shows its thread as `t3:<thread>`.

- It is `tools claude run --sdk` for the account: the real binary with no shell, so T3's permission mode applies.
- An automatic pick keeps the account a resumed session last ran on while that account can serve, so a thread does
  not lose its prompt cache to an account switch. A T3 capability probe (`--no-session-persistence`, no session)
  reuses the last automatic pick (`~/.genesis-tools/claude/embed-last-pick.json`) and runs no usage ranking. On
  2026-11-01, 45 of 60 launches were such probes, each with a full usage poll, before this change.
- `proxy:<account>/<provider>` runs Claude Code against the ai-proxy without the shell wrapper.
- `TOOLS_CLAUDE_EMBED_STEER=next` rewrites a steer (a stream-json user message with `priority: "now"`, which aborts
  the running tool) to `priority: "next"`, which waits for the next tool boundary. A steer then no longer stops a
  command; the Stop button still does.

`tools t3 launchers install` writes the launchers and `tools t3 providers add|sync` writes the T3 instances (see
[`../t3/README.md`](../t3/README.md)).

### `exec`: a pinned token for any command

```bash
tools claude exec -a work -- claude -p "summarize the diff" --output-format json
```

`tools claude exec [-a <account>] [--no-verify] [--] <command> [args...]` runs any command with that account's
long-lived token in its environment, so `claude -p` in a hook, CI or a handoff never depends on whichever account
the keychain holds. Only a LEADING `-a`/`--account` belongs to `exec`.

- Eligible accounts are `anthropic-sub` accounts with a long-lived token. None: run `tools claude login-long` first.
- Without `-a`, a TTY asks; a non-TTY run picks by the same usage heuristic as the picker and skips dead, expired
  and weekly-blocked accounts.
- A token shorter than 100 characters is refused as truncated (a full one is about 108): it would 401 and Claude
  Code would silently fall back to the keychain login. Before the spawn, a read-only probe (a GET, no billing)
  checks the token; `--no-verify` skips it.
- A missing command exits 127; otherwise `exec` exits with the command's code.

### `teams`

`tools claude teams` lists Claude Code agent teams for the current project (`--all` for every project) and
re-attaches a teammate with OAuth: it focuses a live pane, splits the lead's tmux, or launches
`tools cc run -- --agent-id …`. `--account` picks the account for that launch, `--json` dumps the tree, and
`--watch` re-prints it every 2 seconds.

## Accounts, usage and billing

Accounts live in the shared AI config (provider `anthropic-sub`), so `tools ai`, `tools ask` and ai-proxy see the
same accounts. An account can hold three credentials:

| Credential | Added by | Used by |
|---|---|---|
| OAuth pair (access and refresh token) | `login` | usage polling, `warmup` |
| Long-lived token | `login-long` | `start`/`run`, `exec`, `embed`, `worker`, `warmup` fallback |
| Secondary grant | `login-secondary` | `start --keychain` only, never usage polling |

`logout [name]` removes one or more of them: `--oauth` (stops usage polling), `--long-lived`, `--secondary`,
`--both` (the OAuth pair and the long-lived token), `--all`, and `-y` to skip the confirmation. `login-long` asks you
to paste the output of `claude setup-token`, or mints it with `--setup-token`.

- **`usage`** opens a TUI over every account. `--account <name...>` (alias `-f/--filter`) limits it, `--range`
  takes `60m`, `6h`, `24h` or `7d`, `--json` prints the data (`--scored` adds the ranking the picker uses),
  `--no-tui` prints plain text, and `--fresh` forces a live fetch past the shared cache (45 seconds). `--token`
  reads one access token instead of the config. `usage sessions` lists sessions with their 1-hour prompt-cache
  state as JSON (`--hours`, default 6; `--min`; `--host t3` for app-hosted sessions only).
- **`info [name]`** prints account info and cached usage with no network call. The status line runs it in every
  session. Without `[name]`, it pairs a `CLAUDE_CODE_OAUTH_TOKEN` piped on stdin (never argv, which `ps` shows)
  with the configured accounts.
- **`warmup`** sends one tiny request per account to start its 5-hour timer (`--all` for every enabled account, no
  prompt; `--json`). It uses the OAuth pair, and the long-lived token when the account has no pair or the pair fails
  to authenticate. An account without a 5-hour limit is skipped while its weekly window runs, because it has no
  session timer to start. It is the same command as `tools ai warmup`.
- **Auto-warmup** (`tools claude config`, then "Auto-warmup") lets the usage daemon send the warmup by itself: a
  session warmup inside a schedule (06:00 to 22:00 by default, last ping 5 hours before the end), and a weekly-reset
  warmup. Both are off by default.
- **`anchor [name] [date]`** shows or corrects the billing day that projected renewals come from. Anthropic's
  profile has no renewal date. The anchor is the manual date when set, else the later of a watched reactivation and
  the profile's signup stamp (`subscription_created_at`, which does not move when the plan changes). A date is
  `2026-07-07` or an ISO timestamp; a day that does not exist is refused. `--clear` drops the manual date.
- **`daemon register`** registers usage polling with `tools daemon` (`-i`, default `every 60 seconds`;
  `--retention-days`, default 3; `--retention-min`, default 100). It is an alias of `tools ai usage daemon`: one
  task (`ai-usage-poll`) polls every provider, and `register` removes the old `claude-usage-poll` task on the way.
- **`config rename`** carries the account's usage history, warmup lists and defaults across, best effort per store.
- **`spending`** is `tools ai-spend` under another name: `summary` (default), `sessions`, `today`, `daily`,
  `weekly`, `monthly`, `session`, `blocks`, `statusline`, one group per agent (`claude`, `codex`, `grok`, ...),
  `series`, `workers`, `pivot`, `plans`, `proxy`, `waste` and `monitor`. Shared flags: `--since` (default `30d`),
  `--model`, `--project`, `--top`, `--sources`, `--harness`, `--json`. See
  [`../ai-spend/README.md`](../ai-spend/README.md).

### `doctor` and `who`: which account really pays

Claude Code falls back to the keychain login whenever the pinned token's request fails (a 401 for an expired token,
a 429 for an empty bucket). A session can look pinned while every turn bills the keychain account.

- **`tools claude doctor`** finds running pinned sessions in that state, from the process env (the pin), the config
  (the current token) and the usage cache (the buckets). It is a diagnostic: it never refreshes a token and never
  fetches live usage. `--identity` also proves which account each stored token bills and flags two accounts that are
  secretly one; it spends one 1-token completion per account, so it is opt-in.
- **`tools claude who`** (alias `active`) lists live claude processes with the account each runs as (from
  `TOOLS_CLAUDE_ACCOUNT`), the session and its cmux tab. `keychain?` means the process was started outside
  `tools claude run`. `--all` adds helper processes, `--json` prints rows. `tools ai accounts
  who` shows the same table.

## History and transcripts

```bash
tools claude history "callback" --file src/auth.ts --context 2
tools claude history "callback" --all --sort-relevance --exclude-thinking
tools claude history --since "7 days ago" --tool Bash -q "index"
tools claude history index status
tools claude resume "parser bug"
tools claude tail --include thinking,tools,agents
```

`history` and query-based `resume` read the provider-native history index that Claude, Codex and Grok share. It
is built on first use and synchronized with changed sources on every search or listing, so no indexing step is
needed. `index sync` and `index rebuild` are optional maintenance; `index status` is read-only. A bare
`history index` is `sync`, and an explicit `sync` or `rebuild` also runs the statistics pass, the only writer of the
message counts a listing shows. Indexing never imports credentials and never migrates source conversations.
Searches stay scoped to Claude and the current project unless `-p`, `--cwd` or `--all` is given.

- **Scope and size.** `-p/--project <name>` picks a project by its folder's leaf name, `--cwd <path>` by its working
  directory, `--all` searches every project. `-l/--limit <n>` caps the results (default 20), and `-i/--interactive`
  asks for the search with prompts.
- **Search flags.** `--exact`, `--regex`, `-f/--file` (repeatable), `-t/--tool`, `-c/--context`, `--summary-only`,
  `--list-summaries`, `--agents-only`, `--exclude-agents`, `--exclude-thinking`, `--exclude-session`,
  `--exclude-current`, `--commit <hash>`, `--commit-msg <text>`, `--sort-relevance`, `--since`/`--until` and
  `--conv-date`/`--conv-date-until`. `-q/--query` is the only way to search for a word that is also a subcommand
  name (`index`, `dashboard`). `--json` or `--format json` prints machine output; the default format is `ai`.
- **The index database** is `~/.genesis-tools/claude-history/index.db`. History adds provider identity and bounded
  metadata to it; searches read the matching text and context from the native transcripts. A rebuild keeps the
  native sources, the credentials and the database's historical usage and spending observations. Never delete the
  whole database as a cache reset.
- A non-interactive `resume` query with several matches fails instead of silently taking the first session.
- **`resume [query]`** takes a short id, a name or a search term. `-l` lists recent sessions, `-a` searches every
  project, `-n` sets the count (default 20).
- **`tail [query]`** follows a session (`-a <id>` for a subagent). `--include` picks content: `thinking`, `tools`
  (`tools:in:500,tools:out:500`), `agents` (`agents:input,agents:tools,agents:result`), and the finer forms
  `tools:in[:<chars>]`, `agents:tools:out[:<N>]`, `agents:thinking`. A later specifier overrides an earlier one.
  `-t` last turns (default 5), `-c` last calls, `--no-follow`, `--stop-on-finish`, `--raw`, `-o <file>`, `-l`/`-ll`
  to list sessions.
- **`export <session-id>`** writes `full`, `mini` or `raw` output to stdout or `-o <path>` (colors are stripped
  in a file). `--include` takes the `tail` specifiers.
- **`transcript <session-id> --json`** replays the transcript as turns for the GenesisTools Session Details window
  (`--limit`, default 80; `--offset`).
- **`summarize`** runs a template over one or more sessions (`-s` repeatable, `--current` reads
  `$CLAUDE_CODE_SESSION_ID`, `--since`/`--until`). `-m` picks the template: `documentation` (default), `changelog`,
  `debug-postmortem`, `learnings`, `memorization`, `onboarding`, `short-memory` or `custom` (`--custom-prompt`).
  `--provider` and `--model` pick the LLM. `--prompt-only` prints the prompt and calls no model; `--thorough` chunks
  a large session; `--max-tokens` (default 128000); `--include-tool-results` and `--include-thinking` add those
  parts to the extraction; `--priority` is `balanced` (default), `summary-first`, `user-first` or
  `assistant-first`. Output goes to `-o`, `--clipboard`, `--apple-notes` or `--memory-dir`. It calls an LLM, which
  can cost money on a metered provider.
- **`memory`** reads and writes the project-scoped `MEMORY.md` at
  `~/.claude/projects/<encoded cwd>/memory/MEMORY.md`. `append` adds `- ` when the entry lacks it.
- **`history extract-shell-quirks`** scans transcripts for zsh and bash mistakes (NOMATCH, unquoted URLs and globs,
  `*(N)` failures) and writes markdown (`-o`, `--md`) or JSON. Repeats collapse to `×N` unless `--no-dedupe`.
- **`history dashboard`** is the Claude History Browser web app on port 3069
  ([`../claude-history-dashboard/README.md`](../claude-history-dashboard/README.md)). `up` starts it in the
  background (`-f` to block, `-p` for another port), `down`/`stop`, `restart`, `status`, `attach`, `logs`, `open`
  (prints the URL and a QR code), and `install`/`uninstall` for a launchd service. Its background log is
  `~/.genesis-tools/logs/claude-history.bg.log`, capped at 10 MB: on 2026-11-05 the uncapped log reached 19.6 GB in
  three hours.

## Talking to running sessions

### `wait`: block until a turn ends

```bash
tools claude wait <id|title> --timeout 600 --json
tools claude wait <id> --next --stream          # the next turn, printed while it runs
```

`wait` reads the session's transcript, never the pane, and exits when the current turn ends. The shared file
watcher (`watchFileFeed`) wakes it on every write; a 5-second poll only notices silence and the deadline. An idle
session returns at once; `--next` waits for the next turn instead.

| Exit | Meaning |
|---|---|
| 0 | The turn ended (also when it ended on a question) |
| 1 | No session matches, or another error |
| 2 | A bad `--timeout`, `--stall-timeout` or `--last` value |
| 3 | A running turn wrote nothing for `--stall-timeout` seconds (default 900, `0` never) |
| 4 | The turn ended on an error and did no work (`error` in JSON) |
| 124 | `--timeout` passed |

- `<session>` is an id (8 or more characters), a transcript path, a cmux surface title or a `/rename` title.
  `--first` takes the newest when a title matches several.
- Without `--json`, the final assistant message goes to stdout and one status line to stderr. `--last <n>` prints
  the last N assistant messages (separated by `---`), `--tools` adds the tool calls of the turn
  (`tools: Bash ×2, Edit ×1`), `--quiet` keeps only the requested output and the status line.
- `--json` prints `{outcome, state, sessionId, lastText, asksQuestion, interrupted, questions, durationMs, ...}`.
  `asksQuestion` is true when the session waits on its question tool: Claude `AskUserQuestion`, Codex
  `request_user_input` (unanswered) or a turn that ended on `request_user_input_async`, Grok `ask_user_question`
  or `exit_plan` (no result yet). It comes from the tool calls, never from the wording; the old `?`/`❓` wording
  check is kept behind `DECISION_HEURISTICS` (off) in `src/utils/ai/transcripts/turn-wait.ts`. Never answer a
  design question for the human.
- A question the agent asks while it keeps working does not end the wait; it is listed in `questions` (and on
  stderr) when the turn ends.
- The same verb exists as `tools codex wait` and `tools grok wait`. There `<session>` can also be the Grok session
  summary or the Codex thread name.

### `message`: send into a running session

```bash
tools claude message <id|name|title> "status?"
tools claude message <id> --wait --wait-timeout 900 "run the tests and report"
echo "long brief" | tools claude message <id> -
```

`message` (also `tools codex message` and `tools grok message`) sends through the agent's own channel, never by
typing into its pane.

- **Claude** uses the session's cross-session socket (`~/.claude/sessions/<pid>.json` names
  `/tmp/cc-socks/<pid>.sock`). A busy session reads it between tool calls; an idle one starts a turn. The receiver
  sees a message from another session (advice, not the user's own words).
- **Permission modes.** Sent from inside a Claude Code session, the message carries the `cross-session-message`
  envelope that names that session and its permission mode (bypass or prompting), as Claude's own SendMessage
  does. The receiver delivers it at once when the mode matches its own and holds it for approval when they differ.
  A send from outside Claude Code names no mode, so a session in bypass mode holds it.
- **Sessions GenesisTools starts accept everything by default.** `tools claude run` (and `tools cmux agents new
  claude` through it) passes `--settings {"crossSessionInbound":"accept"}`. The default is the
  `launch.crossSessionInbound` key of `~/.genesis-tools/claude/config.json` (`accept` or `hold`, default `accept`).
  `tools claude config cross-messages` prints it and where it comes from; `tools claude config cross-messages hold`
  saves another value. `hold` passes nothing, so Claude Code's own settings decide. Per run, `--cross-messages` or
  `--no-cross-messages` wins over the key, and a `--settings` of your own after `--` turns the default off (Claude
  Code takes one `--settings`). Sessions started by hand keep Claude Code's own setting.
- **Codex** uses `codex queue` on the shared app-server; it needs a TUI attached to that server. **Grok** has no
  structured channel (the TUI listens on no socket). Where there is no channel, `--allow-keystrokes` pastes into the
  session's cmux tab with `cmux paste --submit`, which refuses over a draft or an open dialog.
- `<session>` is a session id or 8+ character prefix, the session name, a `/rename` title, or part of the cmux tab
  or workspace title (`checkout` finds the tab "checkout - grok"). Several matches fail with each candidate's exact
  command; `--first` takes the newest. `-` reads the text from stdin. `--priority now|next|later` (Claude).
  `--dry-run` resolves the session and sends nothing.
- `--wait` waits for the end of the turn the message starts and prints the reply, with the exit codes of `wait`.
  Right after the send, stderr gets one delivery line (who got it, busy or idle); a pipe such as `2>&1 | tail` holds
  that line back until the wait ends. `--wait-timeout`, `--stall-timeout`, `--stream`, `--last`, `--tools` and
  `--quiet` work as in `wait`, and `--json` prints the wait report with a `delivery` field. A reply that ended
  before the wait began still counts, because the send time is the baseline.
- This is not the agents bus: `tools agents message` sends to agents logged into a bus session.

### `queue`: durable messages for one session

`tools claude queue --session <id> --home <abs path> --prompt <text>` saves a message for that exact native
session under `~/.genesis-tools/agent-messages/` (`--queue-root` overrides). `--home` is the session's Claude Code
home (the folder that holds `projects/`) as an absolute path. Every queue subcommand needs the same `--session` and
`--home`, or it fails:

```bash
tools claude queue --session <id> --home <abs path> list                               # read, claim nothing
tools claude queue --session <id> --home <abs path> offer <msg-id> --consumer <name>   # claim for a consumer
tools claude queue --session <id> --home <abs path> ack <msg-id> --consumer <name>     # received, after reading
tools claude queue --session <id> --home <abs path> cancel <msg-id>                    # drop an unoffered message
```

An offer is not a receipt: only the `ack` by the same consumer counts as received. `--idempotency-key` reuses a
message only when its text is unchanged; `--prompt-file` reads the text from a file. Every queue command prints
JSON. The decision delivery ladder below falls back to this queue.

### `decide`: answer a DECISION in the pane

`tools claude decide --session <id> --decision 4 --option b` types one answer into the cmux pane that runs the
session (`--option ac` for a decision that takes several). `--question <formId>` also answers the pending
`tools question` form, so `/qa` keeps the answer. `tools claude decide links --decision 4 --options a,b,c`
prints one markdown link per option to paste under a `❓ DECISION` (`--labels` sets the link texts; `--session`
defaults to the session running the command).

### Decision answers from the inbox

A decision answer from the inbox (`tools question decisions send`, the hub) is delivered by `deliverToSession`
(`src/question/lib/decisions/deliver.ts`) down a ladder of rungs, and the result names the rung in `channel`:

1. `codex`: a Codex thread that a live `tools codex` worker runs is steered through the app-server (`codex steer`,
   with an input receipt).
2. `resume`: a Claude or Grok session that GenesisTools owns as a worker gets a resumed turn
   (`claude worker steer`, `grok steer`), acknowledged by a completed same-session turn.
3. `claude-peer`: a live interactive Claude session gets the message on its cross-session socket. A session that
   GenesisTools started accepts it at once by default (`launch.crossSessionInbound`); another session in bypass mode
   may hold it for approval.
4. `grok-leader`: an interactive Grok TUI inside a shared Grok leader (`tools cmux agents new grok` starts it as
   `tools grok run --leader-socket <sock> --session-id <uuid>` and records both under the session record's
   `providers.grok.leader`) gets the answer as an ACP `session/prompt`, sent by a second client
   (`grok agent --leader --leader-socket <sock> stdio`, `GrokAcpClient` in `src/utils/ai/grok/acp.ts`). The socket
   comes from the record, else the default `~/.grok/leader.sock`; the session is matched by id through
   `session/list`. Delivered means the leader queued the prompt (`_x.ai/queue/changed`); the turn then runs in the
   leader and the TUI shows the prompt and the answer. No socket, no listed session, or a refusal falls through to
   the pane; a prompt with no acknowledgement is an unknown outcome and is not typed again. `tools grok cmux send`
   tries the same rung first (`structuredSend` in `src/grok/lib/spec.ts`), except with `--dry-run` or `--no-enter`.
5. `cmux`: the last rung types into the session's pane with `tools claude cmux send --paste --exact-session`, after
   the dialog guard said no dialog is open.
6. `queued`: no rung took it, or the guard refused; with a source home and a delivery key the message is saved for
   this exact session with the reason.

Only the `cmux` rung types, so only it is guarded; the other rungs are structural and a dialog cannot swallow
them. The delivered text opens with one line that says it is the user's own answer relayed from the decision inbox
(`RELAYED_ANSWER_HEAD` in `src/question/lib/decisions/delivery-text.ts`), then
`DECISION <n>: <letter>) <the user's words>` per answer.

## cmux: sessions as panes

Pick recent Claude Code sessions and rebuild them as cmux panes, each one resuming under the account it originally
ran as. It is built for the machine-died case, and for pulling a set of threads back up on purpose. Bare
`tools claude cmux` is `tools claude cmux restore`.

```bash
tools claude cmux                       # pick from the 12 most recently active sessions
tools claude cmux restore --last 30     # reach further back
tools claude cmux restore --this-project
tools claude cmux restore --dry-run     # print the plan, touch nothing
tools claude cmux snapshot before-reboot
tools claude cmux restore before-reboot
tools claude cmux list                  # saved snapshots
tools claude cmux tree                  # live window, workspace, pane, surface map with session ids
tools claude cmux open-session <id> --workspace workspace:1   # resume as a new pane there
tools claude cmux send <id> "run the tests"   # paste into the session's own pane
tools claude cmux send <id> "/compact" --no-enter --dry-run
tools claude cmux send <id> --option b        # answer the open AskUserQuestion by its option key
tools claude cmux read <id> --lines 40        # print that pane's text
tools claude cmux find <id> --decision 7      # transcript view (ctrl+o) at DECISION 7, tab raised after a hit
```

In a terminal, a bare restore first asks which sessions to offer: every project (the default) or only this
project's. `--this-project` and `--all-projects` answer it; a snapshot, `-y` or a run without a TTY skips it and
offers every project.

Each pane runs `cd <session cwd> && tools claude start <account> -- --resume <id>`. The `--resume` sits after `--`
so claude gets the id verbatim; before it, `tools claude start` would treat the id as a search query and prompt.

### Layout (`restore`)

Sessions group into one workspace per project (`--no-per-project` merges them), and each workspace holds an even
grid:

| Flag | Effect |
|---|---|
| `--layout capped` (default) | `--per-workspace` panes (4); the rest go to `project 2`, ... |
| `--layout grid` | One workspace, every session a pane |
| `--layout tabs` | Fill the cap in panes, then stack the rest as tabs inside them |

Past about 8 panes, `grid` reaches cmux's minimum pane size and cmux clamps it there.

Other flags: `--account <name>` forces one account on every pane, `-a` auto-picks for panes with no recorded
account, `--no-enter` queues each command at the prompt instead of running it, `--new-window` builds in a fresh cmux
window, `--all-projects` skips the scope question, `-y` skips the picker and the confirmation.

`snapshot [name]` saves the active sessions as a named set (`--last`, default 20; `--within <hours>`, default 12;
`--this-project`; `-y`). `list` shows the sets, `forget <name>` deletes one. Snapshots live in
`~/.genesis-tools/claude-code/cmux-snapshots/`.

### `tree`, `open-session`, `focus`, `find`, `read`

- **`tree`** (`--json` for machines) lists every cmux window and marks each surface with the Claude Code session it
  hosts, from the refs journal plus the `· 8hex` tab-title marker.
- **`open-session <session>`** resumes one session at a chosen level: `--window` makes a new workspace,
  `--workspace` a new pane, `--workspace --pane` a new tab, `--workspace --surface` types the resume command into
  that surface (`--no-enter` queues it). The command comes from the same builder `restore` uses, so the pinned
  account and auth mode survive.
- **`focus <session>`** focuses the pane a session already runs in and raises cmux (`--no-activate` leaves cmux in
  the background). `--exact` accepts only a pane proven to run the session (hook journal, resume command, id in the
  tab title), never one that only shows its id on screen.
- **`find <session> [text]`** opens the transcript view (ctrl+o), searches it with `/`, and raises the tab.
  `--decision <n>` finds where `❓ DECISION <n>` was first asked (implies `--at oldest`); `--link` prints a link
  that runs the search when clicked (`--uses`, default 1, for a text link minted on this Mac).
- **`read <session>`** prints the pane text (`--lines`, `--scrollback`) with the same resolution as `send`.
- `focus`, `find`, `read` and `send` skip the pane the command runs in unless `--include-self`, and take the best
  match on `--first`.

### `send`: type into a session's pane

`send` resolves `<session>` in stages: the refs journal first, then an exact id, an id prefix, the tab title, the
workspace, and finally the working directory. A weak match with more than one candidate is refused rather than
guessed, because typing into the wrong agent session is worse than not typing; `--first` overrides that for the
non-weak cases. `--exact-session` refuses the working-directory and screen-text fallbacks (for automated replies).
`--no-enter` leaves the text in the prompt without submitting it, `--dry-run` prints the target pane and stops,
`--timeout <s>` gives up with exit 124, and `--json` prints the outcome.

- Text goes as one `cmux paste --submit`, which refuses while a person is typing in that prompt (typed keystrokes
  landed in the middle of a person's unsent draft on 2026-11-01) and keeps the text literal (`cmux send` reads `\n`,
  `\r` and `\t` in its text as Enter and Tab). Only a slash command, or `--type`, is typed as keystrokes, and text
  with a newline or a backslash is pasted even then. `--enter-delay` (default 500 ms) is the pause before Enter.
- From an agent, prefer `tools claude message` or `SendMessage` to the session's name or `uds:` socket: they never
  touch the person's prompt.
- **The dialog guard.** `send` refuses while the session shows a question, plan or permission dialog, because the
  text plus Enter would pick an option the user never chose (a live paste into an open `AskUserQuestion` picked its
  first option, 2026-10-30) or land in the dialog's text field. It asks state signals only, never the screen: the
  dialog records the hooks write (`~/.genesis-tools/agents/dialogs/<provider>/<session>.json`), then the
  transcript's turn state, then Claude Code's own registry entry (`status: "waiting"`), which is the one signal that
  sees an open `AskUserQuestion`: the transcript gets that tool call only after it is answered. A refusal exits 1;
  `--json` prints `{ sent: false, reason, dialog }`. `--force` types anyway and passes `--force` to `cmux paste`.
- **`--option <letter>`** answers the open question dialog by key presses, never by text. It reads the newest open
  dialog record of the session (only a record carries the options), maps the letter (or a 1-based position) to the
  option, and writes its key. A key write cannot confirm submission: it exits 1, reports `sent: false` and
  `unconfirmed: true` in JSON, and leaves the record open for a hook or watcher to close on acknowledgement. Check
  the dialog before retrying. It refuses without a key press when no record is open, when the record has no options
  (a plan or permission prompt), when the question count is unknown or more than one, when the letter is past the
  list, when `--expected-dialog <key>` names another dialog, or when the harness has no measured keys.
- The keys are each harness driver's `dialog` part, read through `dialogKeysOf` in
  `src/utils/agents/dialogs/keys.ts`; Claude's are in `src/utils/ai/providers/plugins/anthropic-sub/harness-dialog.ts`.
  Claude's option digit does nothing while focus is on the "Chat about this" text row. Codex and Grok keys are still
  unmeasured, so their dialogs are answered in the terminal.
- An inbox item from a dialog record (`source: "dialog"`) is answered through this path:
  `tools question inbox answer --dialog <provider:session:toolCallId> --option <letter>`, or the widget action
  `dialog-answer`, which the widget setting `dialogAnswer` (`press` by default, or `refuse`) governs.

### The account pin

Nothing in Claude Code's transcripts records which account a session ran as, so the `genesis-tools` plugin records
it at session start with its `hooks/record-session-account.ts` SessionStart hook. No settings.json edit is needed.
`tools claude cmux pins` shows the pins, newest first (`--limit`, default 15; `--json`). They live in
`~/.genesis-tools/claude-code/session-pins.jsonl`.

The hook reads `TOOLS_CLAUDE_ACCOUNT` and `TOOLS_CLAUDE_AUTH` (exported by `tools claude start`). Auth is `token`
(the long-lived `CLAUDE_CODE_OAUTH_TOKEN`) or `keychain` (`--keychain` injects that account's secondary login into
the macOS keychain for the session). Do not infer keychain from a missing OAuth env: Claude Code strips that secret
from hook children. Pins written before that fix that claim `auth: keychain` without a trusted source resume on the
token path.

Only sessions started after the hook landed have pins. A session without one shows as `unpinned` and asks which
account to use when its pane launches (or takes `--account` / `-a`). Plugin edits need a push plus `/plugin update`
before Claude Code picks them up.

## Headless workers

```bash
tools claude worker spawn --name fix-parser -a work --cwd ~/Projects/app --prompt-file brief.md
tools claude worker steer --name fix-parser --prompt "also add a test"
tools claude worker read --name fix-parser --format compact
tools claude worker status --name fix-parser --json
```

A worker is a headless `claude -p` session pinned to one named account (`-a` is required and never auto-picked).
`spawn` (turn 1) and `steer` (each later turn) block until the turn ends, which can take minutes.

- `spawn` needs `--name`, `--cwd` and `-a`, and takes the brief from `--prompt` or `--prompt-file`. `-m` sets
  the model, `--label` tags every cost-ledger row of the session, `--skills`/`--no-skills` and
  `--rules`/`--no-rules` show or hide your personal skills and rules, and `--safe-mode` skips `CLAUDE.md`,
  hooks, skills and MCP.
- `steer --json` returns a same-session turn receipt. `--expect-session`, `--expect-home` and `--expect-turn`
  refuse delivery when the session identity, source home or previous turn changed.
- `read` re-prints a finished turn (`--turn`, default the latest) as raw stream-json, or
  `--format compact|json|jsonl|events|raw` with `--thoughts none|short|full`. `tail` follows the running
  turn (default `compact`) and exits when it ends.
- `stop` kills the running turn and `interrupt` ends it; either way the session survives and the next `steer`
  resumes it. `sessions` lists every worker.
- Files: `~/.genesis-tools/claude/workers/<name>.meta.json`, `<name>.turn<N>.jsonl` and `<name>.turn<N>.err`.

## Other commands

- **`desktop`** copies skills from `~/.claude/skills/` into Claude Desktop's skills plugin under
  `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/` and updates its manifest. It
  refuses to overwrite a built-in skill (`creatorType: anthropic`). `--all` installs every skill without the picker,
  `--list` shows the install status.
- **`code`** fetches published `@anthropic-ai/claude-code` versions, extracts the JS bundle from the native binary,
  and diffs or bisects it to find when a code pattern changed (`versions`, `unpack <version>`, `diff <v1> <v2>`,
  `bisect <from> <to> --pattern <regex...>`). The cache is `~/.genesis-tools/claude-code/cache/`. The full manual,
  with the cron slash-command regression it found in 2.1.196, is [`commands/code/README.md`](commands/code/README.md).
- **`mcp`** runs the genesis-tools MCP server over stdio (the question, handoff, annotate and jev tools; alias of
  `tools genesis-tools-mcp`). `GENESIS_TOOLS_MCP_CAPABILITIES` (comma-separated, for example
  `question_answer,handoff`) restricts it. `mcp install` registers it with Claude, or with Codex or Grok through
  `--agent codex|grok`.

### `migrate-to codex`

An interactive wizard that moves or syncs Claude assets into Codex locations.

| Asset | Project target | Global target |
|---|---|---|
| Skills | `./.agents/skills/` | `~/.codex/skills/` |
| Commands (prompts) | `./.codex/prompts/` | `~/.codex/prompts/` |
| Instructions (`CLAUDE.md`) | `./AGENTS.md` | `~/.codex/AGENTS.md` |

It discovers skills in `./.claude/skills/*/SKILL.md`, the project's plugins and `~/.claude/skills/*/SKILL.md`;
commands in `./.claude/commands/**/*.md`, the plugins' command folders and `~/.claude/commands/**/*.md`; and the
project and global `CLAUDE.md`.

Plugin skills and commands come from `.claude-plugin/marketplace.json` and `plugins/*/.claude-plugin/plugin.json`.
The wizard asks for the source scope, the components, the target scope, the transfer mode (`symlink`, recommended,
stays in sync; `copy` is a snapshot), the naming style (`prefixed`, recommended, or `preserve`), and a final
confirmation. `ESC` goes back one step instead of cancelling. A target that already exists asks: show a diff (the
shared diff helper in `src/utils/diff.ts`), overwrite, skip, or rename.

| Flag | Meaning |
|---|---|
| `--source <scope>` | `project`, `global` or `both` |
| `--target <scope>` | `project` (default), `global` or `both` |
| `--components <list>` | `skills,commands,instructions` (default: all) |
| `--mode <mode>` | `symlink` (default) or `copy` |
| `--name-style <style>` | `prefixed` (default) or `preserve` |
| `--force` | Overwrite existing targets |
| `--dry-run` | Show the plan, write nothing |
| `--list` | Print the discovered assets and exit |
| `-y, --yes` | Skip the final confirmation |
| `--non-interactive` | Run from the flags, no wizard |

```bash
tools claude migrate-to codex --list
tools claude migrate-to codex \
    --source global \
    --target global \
    --components skills,commands \
    --mode symlink \
    --non-interactive \
    -y
```

## How it works

The tool runs Claude Code itself (the `claude` binary), reads its files under `~/.claude` (or `CLAUDE_CONFIG_DIR`),
and calls Anthropic's OAuth and usage endpoints for the accounts. `proxy` and `codex` go through `tools ai-proxy`;
cmux commands drive the cmux app; `tools claude daemon` registers a task with `tools daemon`.

| Path | What it holds |
|---|---|
| `~/.genesis-tools/ai/config.json` | Accounts (shared with `tools ai`, `tools ask`, ai-proxy) |
| `~/.genesis-tools/security/vault.json` | The encrypted account credentials the config refers to |
| `~/.genesis-tools/claude/config.json` | Notifications, auto-warmup, launch preferences |
| `~/.genesis-tools/claude/workers/` | Worker metadata and turn transcripts |
| `~/.genesis-tools/claude/teammate-wrappers/` | Per-launch agent-team wrappers |
| `~/.genesis-tools/claude-history/index.db` | History index, usage and spending history |
| `~/.genesis-tools/ai-usage/` | The shared usage cache all tools read |
| `~/.genesis-tools/claude-code/` | cmux snapshots, session pins, `code` bundle cache |
| `~/.genesis-tools/claude-codex/config/` | `codex --isolated` config folders |
| `~/.genesis-tools/ai-proxy/sessions/` | `codex` session records |
| `~/.genesis-tools/agent-messages/` | The `queue` messages |
| `~/.claude/projects/<encoded cwd>/` | Claude Code's transcripts and `memory/MEMORY.md` |

`GENESIS_TOOLS_HOME` moves the `~/.genesis-tools` root.

**What costs money.** Launches, workers, `warmup` and `doctor --identity` send real requests, which count against a
subscription or bill a metered account. `summarize` calls an LLM. `info`, `who` and `doctor` without `--identity`
read local state only and spend nothing. `usage` calls no model either; it reads Anthropic's usage endpoint at most
every 45 seconds and serves the shared cache in between.

**What the Mac needs.** Claude Code on PATH, cmux for the `cmux` and `decide` commands, tmux for `--tmux`, and the
genesis-tools Claude Code plugin for account pins and dialog records. Reading the account secrets needs the vault's
master key from the keychain, so macOS can ask whether `gt-claude` may use it.

## Configuration

`~/.genesis-tools/claude/config.json` (edit it with `tools claude config`; `config show` prints it):

| Key | Default | Meaning |
|---|---|---|
| `notifications.sessionThresholds` | `[80]` | 5-hour usage percents that notify |
| `notifications.weeklyThresholds` | `[20, 40, 60, 80]` | Weekly usage percents that notify |
| `notifications.channels.macos` | `true` | macOS notifications |
| `notifications.watchInterval` | `60` | Seconds between polls in watch mode |
| `notifications.extraUsage` | off | JSON only: alert when extra usage turns on, then every +5% |
| `warmup.session` | off, 06 to 22 | Auto session warmup (keys below) |
| `warmup.weekly` | off | Auto weekly-reset warmup (keys below) |
| `launch.crossSessionInbound` | `accept` | `accept` or `hold` for sessions GenesisTools starts |

`warmup.session` holds `enabled` (false), `accounts`, `schedule` (`startHour` 6, `endHour` 22; the last ping is at
`endHour` minus 5), `notify` (true) and `notifyOnlyIfUnused` (true). `warmup.weekly` holds `enabled` (false),
`accounts` and `notify` (true).

Accounts are managed with `login`, `login-long`, `login-secondary`, `logout` and `config add|remove|rename|refresh`,
or with `tools ai config account ...` (see [`../ai/README.md`](../ai/README.md)).

Environment variables:

| Variable | Meaning |
|---|---|
| `TOOLS_CLAUDE_ACCOUNT`, `TOOLS_CLAUDE_AUTH` | Set by `start`; read by hooks, `who`, `doctor` |
| `TOOLS_CLAUDE_EMBED_ACCOUNT` | The account `embed` uses when no operand is given |
| `TOOLS_CLAUDE_EMBED_STEER` | `next` turns a steer into a next-boundary message |
| `CLAUDE_CONFIG_DIR` | Claude Code's home instead of `~/.claude` |
| `GENESIS_TOOLS_MCP_CAPABILITIES` | Restricts the `mcp` server's tools |
| `CLAUDE_CODE_SESSION_ID` | The session `summarize --current` reads |

## For agents

- **Machine output.** `--json` on `history`, `history index`, `usage`, `usage sessions`, `warmup`, `who`, `teams`,
  `wait`, `message`, `queue` (the default), `worker steer|status|sessions`, `code versions|bisect`, `cmux focus`,
  `cmux send`, `cmux list`, `cmux pins`, `cmux tree`, `cmux open-session`, and `spending`. `info --format json`.
- **Exit codes.** `wait` and `message --wait`: 0 done, 1 error, 2 bad flag value (`message` then sends nothing), 3
  stalled, 4 turn failed, 124 timeout. `cmux send` exits 1 on a refusal and 124 on `--timeout`. `start` exits 1 on
  an account with no weekly quota left. `exec` exits with the command's code (127 when it is missing).
- **Reaching a session.** Prefer `message` (the agent's own channel) over `cmux send` (the pane). Use `wait` to
  block on a turn; read `asksQuestion` and never answer a design question for the human.
- **A second Claude account for a task.** Use `tools claude worker spawn|steer|read|status`, or
  `tools claude exec -a <account> -- claude -p ...` for one turn. The `handoff-to` plugin skill
  (`plugins/genesis-tools/skills/handoff-to/references/claude.md`) covers this flow.
- **Plugin skills.** `claude-history` (finding past sessions), `summarize`, `handoff-to` and `agents-talk` in
  `plugins/genesis-tools/skills/`.
- **MCP.** `tools claude mcp` serves the genesis-tools MCP tools; `tools claude mcp install` registers them.

## Troubleshooting

- **A session bills the wrong account.** Claude Code falls back to the keychain login when the pinned token fails
  (401 or 429). Run `tools claude doctor`; recapture the token with `tools claude login-long <name>`. A dated
  observation from the `handoff-to` skill: Claude Code 2.1.202 was seen swapping `CLAUDE_CODE_OAUTH_TOKEN` for the
  keychain login after startup in an interactive session, while headless `-p` was unaffected. It was not re-tested
  on later builds.
- **Every session on the Mac refuses turns.** An interactive session gates its turns on the keychain account's
  limits, not the pinned token's: a long-lived token is inference-only (the profile endpoint answers 403 to it), so
  the UI reads usage from the keychain login. Inference still bills the pinned account. A keychain account with no
  limit left stops every session; `start` warns and suggests `tools claude start --keychain <account>`.
- **An account with an empty weekly bucket.** It cannot serve any model: every turn gets a 429 and Claude Code
  falls back to the keychain account. `start` refuses such an account (exit 1) and names the accounts with weekly
  headroom. It checks this before its Fable and `--model` checks.
- **`exec` says the token is truncated.** The stored token is shorter than 100 characters (a full one is about 108).
  Recapture it with `tools claude login-long <name>`.
- **`who` shows `keychain?`.** That process was started outside `tools claude run`, so it has no
  `TOOLS_CLAUDE_ACCOUNT`.
- **A cmux pane asks which account to use.** The session has no pin: it started before the plugin hook, or without
  the plugin. Pass `--account` or `-a` to `restore`.
- **`cmux send` refuses.** A dialog is open, or a person is typing in that prompt, or the match is weak. Read the
  reason in `--json`, check the pane, and answer a question dialog with `--option`.
- **`history` finds nothing that exists.** Searches stay in the current project; add `-p <name>` for another
  project or `--all` for every project. To search for a word that is a subcommand name, use `-q <word>`.
- **A macOS prompt asks whether `gt-claude` may use the keychain.** A command decrypted the account secrets, which
  reads the vault's master key. `info <name>` avoids it by reading only the account list.

## Related

- [`../cc/README.md`](../cc/README.md): the short alias.
- [`../ai/README.md`](../ai/README.md): accounts, `ai warmup`, `ai usage daemon`, `ai accounts who`.
- [`../ai-proxy/README.md`](../ai-proxy/README.md): the proxy behind `proxy` and `codex`.
- [`../ai-spend/README.md`](../ai-spend/README.md): what `spending` runs.
- [`../codex/README.md`](../codex/README.md) and [`../grok/README.md`](../grok/README.md): the same `wait` and
  `message` verbs for Codex and Grok.
- [`../cmux/README.md`](../cmux/README.md), [`../tmux/README.md`](../tmux/README.md): the terminals the session
  commands drive.
- [`../t3/README.md`](../t3/README.md): T3 Code launchers and providers for `embed`.
- [`../question/README.md`](../question/README.md): the decision inbox that delivers through this tool.
- [`../agents/README.md`](../agents/README.md): the agents bus.
- [`../daemon/README.md`](../daemon/README.md): the scheduler behind `daemon register`.
- [`../genesis-tools-mcp/README.md`](../genesis-tools-mcp/README.md): the MCP server behind `mcp`.
- [`../claude-history-dashboard/README.md`](../claude-history-dashboard/README.md): the history web app.

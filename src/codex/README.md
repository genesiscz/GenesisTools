# tools codex

`tools codex` runs OpenAI's Codex CLI under GenesisTools accounts. It opens the native Codex terminal as a named
ChatGPT subscription account, runs headless Codex workers that a lead agent steers, approves and reviews, searches
your Codex conversation history, and maintains Codex homes and the Codex desktop app on macOS.

## Quick start

```bash
tools codex login work                               # log a ChatGPT subscription account into the shared vault
tools codex run work --model sol                     # open the native Codex terminal as that account
tools codex resume "invoice parser" --account work   # resume a conversation by id, title or content
tools codex history "invoice parser" --all           # search every Codex conversation on this Mac
# start a headless, read-only worker as that account
tools codex spawn \
  --name explain \
  --account work \
  --no-agents \
  --prompt "Explain what src/app.ts does"
tools codex tail --name explain --follow             # watch the worker until its session closes
```

`tools codex --readme` prints this page. `-v, --verbose` turns on verbose logging. For `run` and `start`, put it
before the subcommand (`tools codex -v run work`), because everything after `run` belongs to the launch.

## Commands

The commands are grouped by job. Each group lists its commands, then the flags and rules that matter.

### Native terminals and accounts

```bash
tools codex run [account] [args...]       # alias start: the native TUI as one account; args after -- go to codex
tools codex resume [query]                # the same launch, resuming by id, title or content (bare: native picker)
tools codex embed [account] -- <args>     # codex for an app that embeds it as a provider (T3 Code)
tools codex who                           # alias active: live codex processes, their account, session and cmux tab
tools codex cmux focus <session>          # focus the cmux pane a session is already open in
tools codex cmux send <session> <text>    # type text into that pane, then press Enter
tools codex login [name]                  # browser OAuth login, the grant stored in the shared vault
tools codex usage                         # rate-limit windows of the Codex accounts (interactive TUI)
tools codex warmup [account...]           # one tiny request per account to start its session timer
tools codex models                        # the Codex model catalog, each field with its source
```

`run` flags:

| Flag | Meaning |
| --- | --- |
| `-r, --resume [query]` | Bare: the native picker. A query searches the history index |
| `-c, --continue` | Continue the most recent session in this directory |
| `-m, --model <model>` | Model id or alias |
| `--all` | With `--resume`, search every project, not only this directory |
| `--cwd <path>` | Working directory |
| `--home <path>` | Shared Codex home (default `~/.codex`, never the inherited `CODEX_HOME`) |
| `--computer-use` | Require the official Mac Computer Use runtime |
| `--no-computer-use` | Skip the Computer Use configuration overrides |

`resume [query]` takes `--account <name>` (the picker runs when you omit it), `-l, --list` (list the matches
instead of launching), `-a, --all`, `-n, --limit <n>` (default 20), `-m, --model` and `--cwd`.

Other flags:

- `who`: `--json`, `--all` (include helper processes). The account comes from `TOOLS_CODEX_ACCOUNT` in each
  process's environment; `native?` means the process was launched outside `tools codex run`.
- `cmux focus`: `--no-activate` (do not raise the cmux app), `--first`, `--include-self`, `--dry-run`, `--json`.
- `cmux send`: `--no-enter`, `--enter-delay <ms>` (default 500), `--first`, `--include-self`, `--dry-run`,
  `--json`, `--timeout <seconds>` (exit 124 when the whole send runs out of time).
- `login`: `--import-native`, `--auth-file <file>`, `--home <dir>`, `--broker` (see "Login" below).
- `usage`: `--account <name...>`, `--range 60m|6h|24h|7d`, `--json` (snapshots instead of the TUI), `--fresh`
  (a live poll that bypasses the shared cache).
- `warmup`: `--all` (every enabled account, no prompt), `--json`. An account without a 5-hour limit is warmed
  only when its weekly window is idle. The same code runs behind `tools ai warmup`.
- `models`: `--account <name>` (also read the live list with this login; read-only, never refreshes),
  `--model <id>` (one model, every field with its source; a slug or an alias such as `sol` or `sol6`),
  `--all` (include models the backend hides), `--json`.

#### Choosing the account

The account argument is matched by substring within `openai-sub` accounts, the same rule `tools claude run` uses
for its target. An exact id or account name wins first. Otherwise every whitespace- or slash-separated token of
what you typed must appear in an enabled account's name (`work` matches `cdx-work`). A name that is also the exact
name of an account on a different provider never wins by accident, because the match is scoped to `openai-sub`.
Several matching accounts is an error that names the candidates.

With no account, `run` and `resume` open a picker that shows each account's cached usage. `auto` ranks the
accounts by the cached usage and prints the pick and the runner-up (an account literally named `auto` wins
over this). When the cache shows no account with headroom, `auto` fails; name an account, or refresh the cache
with `tools codex usage`.

#### Account-bound terminals

```bash
tools codex run work --model astra
tools codex run work --model terra --resume
tools codex run work --model luna --resume "invoice parser"
tools codex run work --resume "invoice parser" --model sol
tools codex run --cwd ~/Projects/app --model astra work

# Native arguments remain available behind --.
tools codex run work -- resume <thread-id>
```

`run` attaches the original terminal UI to a private local app-server. Each launch holds the selected account's
authentication in memory and uses the same real `~/.codex` for configuration, plugins and conversations. An
inherited `CODEX_HOME` does not select another target home; pass `--home` to choose one.

It requires Codex CLI 0.153.4 or newer, on macOS or Linux. The external-token and native remote-terminal
interfaces are experimental upstream. The interactive launcher needs a TTY; use `spawn --account` for managed
workers.

Model aliases resolve centrally:

- `astra` is `gpt-6-astra`
- `terra` is `gpt-6.1-terra`
- `luna` is `gpt-6-luna`
- `sol` is `gpt-6.1-sol`
- `sol6` is `gpt-6-sol`

Full ids and the model aliases of the shared config are accepted. A model alias cannot switch the selected account
or provider. An unsupported model surfaces the native error instead of silently selecting another.

The account-bound connection blocks what would escape the account: persistent login and logout, configuration
writes, alternate providers and non-TUI subcommands. Concretely, the native arguments refuse `--remote`,
`--remote-auth-token-env`, `--config`/`-c`, `--profile`/`-p`, `--oss` and `--local-provider`, and a native
subcommand such as `login`, `exec`, `app-server`, `mcp` or `review` is refused with a pointer to
`tools codex login`. Running processes keep an immutable account and workspace identity across renames and reject
accounts that were disabled or removed. Exit stops the backend, removes its private socket and prints
`Resume with this account: <command>`. Resume through that account wrapper; do not reuse the temporary raw socket
that native Codex prints.

Logging into a named account does not switch the desktop account or replace the shared home's `auth.json`. The
desktop account stays separate from CLI account selection. Avoid editing one native conversation from two
processes at once.

#### Resume

Bare `--resume` opens the native picker. A query searches ids first, then titles and summaries, then transcript
content. The current project is the default scope; `--all` includes other projects of the same provider. An
ambiguous non-interactive query fails instead of choosing the first result.

A full native UUID passed to `--resume` is an exact lookup across projects. It never falls back to a transcript
that merely mentions that id. When the same id is retained in several homes, the target shared home's copy is
preferred. A canonical archived session is unarchived through the native API before the TUI resumes it.

A selected session outside the target shared home offers **Copy and resume** or **Cancel**. The supported legacy
format is staged as a snapshot, then copied through native `thread/fork` and verified by a native resume. Active
and archived originals stay in place. The copy receives a new native id and provenance under
`<target-home>/.genesis-tools/session-imports/`; repeating the same import reuses it. Changed sources, malformed
partial records and divergent provenance are rejected. An uncertain interrupted fork keeps a recovery record and
blocks duplicate retries.

Paginated history can be searched through its native projection store, but a cross-home copy of it is rejected:
the tested native fork path cannot load that separate store. No native SQLite rows are synthesized, and native
databases are never symlinked between homes. Cross-provider history conversion is outside this command's scope.

#### Login

```bash
tools codex login work
tools ai codex login personal
tools ai accounts login work --provider codex
```

These three use one login registration and the shared account core. An ordinary login obtains a new OAuth grant
and stores it in the encrypted GenesisTools vault. Opening the browser, copying the URL, pasting a callback URL and
cancelling use the same helpers as the Claude login. `--broker` remains an alias for this default.

Explicit native-file modes remain available:

```bash
tools codex login work --import-native
tools codex login work --auth-file /path/to/profile/auth.json
tools codex login work --home /path/to/profile
```

- `--import-native` binds the current `CODEX_HOME/auth.json` (or `~/.codex/auth.json`) and fails if it is
  missing.
- An existing `--auth-file` is bound without OAuth and without rewriting it.
- An explicit `--home`, or an `--auth-file` destination that does not exist yet, keeps the native-file login.
- Conflicting vault and native options are rejected before any account write.

A native file reference keeps the Codex CLI as its refresh owner. Vault grants are refreshed only through the
common account binding, under the shared config and vault lock order. Real profiles and existing credentials are
never migrated implicitly.

`login` and `usage` are doors onto the provider-neutral account core: the same code runs behind
`tools ai accounts login --provider codex` and `tools ai usage --provider codex`. Vault accounts do not need a native
auth home for usage polling. `tools ai accounts discover --provider codex` lists every `~/.codex*` profile on the
machine, and `--bind` turns the unbound ones into accounts.

#### Computer Use and JavaScript

When the official Mac runtime (`/Applications/ChatGPT.app/Contents/Resources/cua_node/`) and the helper
(`<home>/computer-use/Codex Computer Use.app`) are installed, `run` supplies process-local Computer Use
configuration by itself. It keeps the existing browser service registrations in `node_repl` and adds the official
`@oai/sky`. Use `--computer-use` to require the installation, or `--no-computer-use` to skip the overrides. The
desktop app regenerating its configuration file cannot erase overrides already supplied to a launch. OS permissions
and browser connections still apply. Worker `spawn` also accepts `--computer-use`.

`node_repl` is the persistent JavaScript runtime, and `@oai/sky` provides native app control. The separate
`cua_repl` plugin is a unified browser and computer wrapper around that runtime that exposes the `cua` APIs. A
successful Sky call does not prove that this separate wrapper is enabled. The launcher does not patch
desktop-managed plugin manifests or install missing plugins.

#### The model catalog

`tools codex models` merges five sources and names the source of every field: `live` (WHAM `/models`, only with
`--account`), `cache` (the Codex CLI's `~/.codex/models_cache.json`), `static` (the built-in table), `default` (a
codex-rs rule) and `override` (`modelOverrides.codex.<slug>` in the ai-proxy config). It shows the window, the
usable and compact percents, the efforts (with the ultra mapping), the default effort, Lite, `comp_hash` and search
support. An expired login skips the live list with a warning, because a listing never spends a refresh token.

### History

```bash
tools codex history [query]                       # search Codex conversations (fuzzy by default)
tools codex history index [sync|rebuild|status]   # maintain the shared index; bare index means sync
```

```bash
tools codex history "invoice parser" --all --sort-relevance
tools codex history --file src/auth.ts --since "7 days ago" --context 2
tools codex history --tool exec_command --exclude-thinking --format json
tools codex history -q index                      # search for a word that is also a subcommand
tools codex history index status
```

`history` flags, by job:

- Scope: `-p, --project <name>` (project or cwd leaf name), `--cwd <path>`, `--all`, `--since <date>`,
  `--until <date>`, `--conv-date <date>`, `--conv-date-until <date>`. Dates take forms such as `7 days ago` or
  `yesterday`.
- Match: `--exact`, `--regex`, `-f, --file <pattern>` and its alias `--files` (repeatable), `-t, --tool <name>`
  (tool names, tool results included), `--commit <hash>`, `--commit-msg <text>`, `--summary-only` (titles,
  summaries and the first prompt), `-q, --query <text>` (the only way to search for a subcommand name).
- Exclude: `--agents-only`, `--exclude-agents`, `--exclude-thinking`, `--exclude-session <id>` (repeatable),
  `--exclude-current`.
- Output: `-l, --limit <n>` (default 20), `-c, --context <n>` (messages around each match, default 0),
  `--sort-relevance`, `--list-summaries`, `--format ai|json` (default `ai`), `--json`, `-i, --interactive`.

Searches and listings build the index on first use and synchronize changed sources, so no manual indexing is
needed. `index sync` and `index rebuild` are optional maintenance, and each also refreshes the statistics pass
(the only writer of the message counts a listing shows). `index status` is read-only. Indexing never imports
credentials or migrates source conversations. History reads do not resolve or refresh credentials.

Claude, Codex and Grok share `~/.genesis-tools/claude-history/index.db` through provider readers. SQLite keeps
bounded metadata and aggregate statistics. User and assistant text, tools and results, and the original context
are read from the native sources, which stay authoritative. Archived sessions and legacy Codex profile homes remain
discoverable. A rebuild does not edit the native files or the database's historical usage and spending
observations. Do not delete that database as a cache reset.

### Headless workers

```bash
tools codex spawn --name <n> [options]        # start a worker: a long-lived app-server session
tools codex steer --name <n> --prompt <text>  # inject input into the running turn
tools codex read --name <n>                   # the current thread snapshot
tools codex tail --name <n> [--follow]        # recent events, and follow them until the session closes
tools codex logs --name <n>                   # read the session event log
tools codex status [--name <n>]               # turn state and cwd; without --name, every session
tools codex sessions                          # every worker session with its derived status
tools codex wait <session>                    # block until a session's current turn ends
tools codex interrupt --name <n>              # end the running turn; the session survives
tools codex rollback --name <n> --turns <n>   # drop turns from the end of the thread
tools codex stop --name <n>                   # stop the session and tear its daemon down
```

```bash
tools codex spawn \
  --name reviewer \
  --mode review \
  --base origin/master \
  --prompt "Review this branch"

tools codex status --name reviewer
tools codex tail --name reviewer --follow
tools codex logs --name reviewer --format compact
tools codex steer --name reviewer --prompt "Focus on the auth path"
tools codex interrupt --name reviewer
tools codex rollback --name reviewer --turns 1   # revert persisted history (thread/revert); files stay
tools codex read --name reviewer
tools codex stop --name reviewer
```

`spawn` flags:

| Flag | Meaning |
| --- | --- |
| `--name <name>` | Session name (required) |
| `--prompt <text>`, `--prompt-file <path>` | The brief; optional, the first prompt may come as a steer |
| `-m, --model <model>` | Model for the session |
| `-a, --account <account>` | Account every turn is pinned to |
| `--cwd <path>` | Working directory (default: this one) |
| `--home <path>` | `CODEX_HOME` override |
| `--write <policy>` | `ask`, `allow`, `deny` or `full` (default: read-only, see below) |
| `--writable-root <path...>` | Additional writable roots |
| `--effort <effort>` | Reasoning effort; for `--mode review` a tier |
| `--mode <mode>` | `task` (default) or `review` (see "Reviews") |
| `--base`, `--pr`, `--paths`, `--allow-shallow` | Review options (see "Reviews") |
| `--label <text>` | Tag every cost-ledger row of the session |
| `--skills`, `--rules` | The default; they change nothing |
| `--no-skills`, `--no-rules` | Refused: the spawn fails (see below) |
| `--computer-use` | Configure the installed Mac Computer Use for this worker |
| `--project <project>` | app-server project (id, name or root) for the thread |
| `--no-agents` | Disable the `tools agents` integration |
| `--session <id>` | Parent `tools agents` session id |

A Codex worker always loads your personal skills and rules. Codex has no control that hides them, so
`--no-skills` and `--no-rules` fail the spawn instead of doing nothing in silence. The flags and their help
text come from the shared worker verbs, so `spawn --help` still says they hide the skills and rules; for Codex
they do not. To limit what a worker loads, spawn it with a lean `--home <dir>`. See
[the handoff-to Codex reference](../../plugins/genesis-tools/skills/handoff-to/references/codex.md), section
"Keeping the worker lean".

`steer` flags: `--prompt` or `--prompt-file`, `--json` (a machine-readable same-session turn receipt),
`--force` (interrupt, then start, when same-turn steering is rejected), `--expect-session <id>` and
`--expect-home <path>` (refuse delivery when the identity changed). `steer` still answers to its older `--body` and
`--body-file` spelling, hidden from help. `--session` and `--home` address a thread that is not your worker; see
"Messages to sessions" below.

`tail` and `logs` flags: `--tail <count>` (`tail` defaults to 20), `--follow` (`tail` only), `--grep <pattern>`
(`logs` only; a regular expression over the serialized events), `--events` (the normalized worker events instead of
raw notifications), `--format compact|json|jsonl|events|raw` (the transcript door every backend shares) and
`--thoughts none|short|full` (reasoning in the compact and events formats). The default raw view stays the
authoritative one for approvals, because it carries the request ids and the transcript formats do not.

`wait <session>` blocks until a session's current turn ends, reading its transcript (no pane scraping). The
session is an id (8 or more characters), a transcript path, a cmux surface title or a `/rename` title. Flags:
`--timeout <seconds>` (default: for ever), `--stall-timeout <seconds>` (default 900; 0 never), `--next` (if idle
now, wait for the next turn), `--stream`, `--json`, `--first` (the newest of several title matches), `--last <n>`,
`--tools`, `--quiet`. An idle session returns at once. Exit codes are listed under "For agents".

`spawn`, `steer`, `read`, `tail`, `status`, `sessions`, `stop` and `interrupt` are the shared worker verbs
(`src/ai/commands/agent/worker.ts`); what makes them Codex is `codexDriver` (`src/codex/lib/driver.ts`). A
persistent daemon with a control channel is what lets Codex offer mid-turn approvals, a turn rollback, a native
review and a raw event log.

#### The parent session and the agents bus

The driver joins the parent swarm through `tools agents`. The parent is the session id assigned in the caller's
environment (a nested worker keeps its parent's swarm), else the host session it runs in: Claude Code, Codex or
grok. Without one, `spawn` fails; pass `--session <id>`, or
`--no-agents` to run without the integration. Approval requests go to the bus member named `lead`, which is
hardcoded.

#### Desktop projects

A spawned worker's thread gets an app-server `projectId` once its first message is recorded: the project named by
`--project <id|name|root>`, otherwise the project whose root holds the cwd (a linked worktree falls back to its main
checkout). An unknown or ambiguous `--project` fails the spawn; `tools codex status` shows the result as
`desktopProject`.

⚠️ That id does not decide where Codex Desktop (26.930) shows the thread. Read from its bundle on 2026-10-13:

- Its sidebar lists its own thread index, which only Desktop's own app-server events, a window load or a reconnect
  refresh. A worker runs its own app-server, so its thread appears after Desktop next re-reads the list (reload the
  window, or restart Desktop).
- It places a thread by cwd (a project root, or a folder below one) and by assignments it wrote itself. A root that
  two projects list belongs to one of them: a single-root project first, then the project that lists it first.
  Desktop reads the app-server `projectId` only behind its `localProjectTaskMembership` flag, which was off.

To land a worker under a project in Desktop today, start it in a folder that project owns by those rules.

#### Write policies and the sandbox

Sessions are read-only by default (`--write deny`, sandbox `read-only`). The other policies:

- `--write ask`: sandbox `workspace-write`, approval policy `untrusted`. Out-of-policy commands and file changes
  pause for a lead decision (see "Approvals").
- `--write allow`: sandbox `workspace-write`, approval policy `never`. For a trusted bounded worker that does not
  commit.
- `--write full`: no sandbox (`danger-full-access`, approval policy `never`). It is refused when the cwd is in a
  main checkout (a `.git` folder at or above it). Use it only in a throwaway linked worktree or a non-git scratch
  folder.

In the `workspace-write` sandbox of `ask` and `allow`, a worker cannot write any path inside a `.git` folder, so it
cannot commit (under `ask` an approved commit runs outside the sandbox). It cannot exec setuid binaries such as
`/bin/ps`, so the `@genesiscz/utils/process/ps` readers that spawn `ps` return nothing. It has no network, so a
`bun install` that downloads fails. `spawn` prints the limits of the chosen policy as warnings and returns them as
`warnings` in its JSON result. The measurements and the way around each are in
[the handoff-to Codex reference](../../plugins/genesis-tools/skills/handoff-to/references/codex.md), section
"What a sandboxed worker cannot do".

### Approvals

```bash
tools codex requests [--name <n>] [--lines 40] [--json]       # pending requests: commands and proposed file content
tools codex request --name <n> --request <id> [--full] [--json]
tools codex approve --name <n> --request <id>
tools codex deny --name <n> --request <id> [--reason <text>] [--by parent|human|policy]
```

With `--write ask`, Codex uses its `untrusted` approval policy. Commands outside Codex's built-in trusted
read-only set, sandbox escalations and file-change approval requests pause and are forwarded to `lead` as
`approval_request` messages. Codex 0.162.1 has no protocol mode that pauses its built-in trusted read-only
commands; `untrusted` is its strictest supported command policy.

Under `--write ask` the daemon accepts no request itself. The worker's own bus commands (`tools agents message`, `login`, `request`,
`leave`) and any read-only command Codex asks about go to the lead like any other, because an automatic approval
of a parsed shell script is only as safe as its parser. Under `allow` and `full` a request that still arrives is
approved; under `deny` it is declined. A file-change approval names the files it writes
(`edit src/a.ts, README.md`); the request itself carries only an item id.

#### Reading a request before you answer

The daemon keeps each in-flight `fileChange` item's `changes`: the whole new file for `add`, the removed file for
`delete`, and a unified diff for `update`, replaced by `item/fileChange/patchUpdated`. A legacy
`applyPatchApproval` brings them inline. The pending record in the session meta holds them as
`changes: [{ path, kind, movePath?, diff }]`. `path` is relative to the cwd inside it and absolute outside it, and
`paths` also names a move's destination. Where to read them:

- `tools codex requests [--name <n>]`: every pending request (of one session, or of all), with its command and cwd
  or its files and content. A request shows `--lines` content lines (default 40) in total. A file cut short ends
  with `… N more lines, tools codex request --name <n> --request <id> --full`.
- `tools codex request --name <n> --request <id> --full`: one request with every proposed line. `--json` (here and
  on `requests`) answers with the stored record itself, so the content is exact, never a preview.
- The `approval_request` bus message to `lead` carries a `preview` (the first 12 lines) and `fullRequest` (the
  command above).
- `tools codex read --name <n>`: while a request waits, the thread snapshot carries `pendingApprovals` with the
  same records, because Codex's own snapshot did not show the proposed file before approval.
  `tools codex status --name <n> --json` has them too, and `tools codex sessions` marks a worker with
  `N pending approvals`.

These are reads of the session file, and none of them answers a request. Only `approve` or `deny` does.

#### Who declines, and why

`deny` says who declined and why. Codex itself tells the worker only `Rejected("rejected by user")`, so on
2026-10-27 a lead's quality refusal read to the worker as a human permission decision, and the worker stopped that
line of work. The two flags:

- `--reason <text>`: why the request is declined. With it, `--by` defaults to `parent`.
- `--by <actor>`: `parent` (the supervising session), `human` (a person at the CLI or the dashboard) or `policy`
  (the session's write policy). Any other value is refused before anything is sent.

With `--by parent` or `--by policy` the daemon declines the request first, then steers the worker a notice that
names the actor ("the parent session that supervises you, not a human") and the reason. During a review or compact
turn the notice waits for the turn boundary; a deny never interrupts the turn. The JSON answer is
`{ "resolved": true, "attributed": true }`. It is `"attributed": false` when the steer failed, and the daemon logs
a warning; the decline stands either way. `--by human` and a plain `deny` keep the human semantics: the worker gets
Codex's own rejection and no notice, and a `--reason` given with `--by human` is not sent. A `--write deny` session
declines every request itself and sends no notice.

An answered request is gone. A later `approve` or `deny` for the same id, from the CLI or as a control message on
the bus, fails with `Pending approval not found: <id>`. So a human refusal cannot be retried as a parent refusal
or approved by another route.

### Reviews

```bash
tools codex spawn --mode review --name <n> [--base <ref>]   # a review worker with a manifest and a depth gate
tools codex review --name <n>                               # a native or adversarial review turn on a session
tools codex reviews                                         # the review ledger, one row per review, with totals
tools codex reviews import <name...>                        # backfill the ledger from older sessions
tools codex review-depth <name>                             # one review: manifest, spend, coverage, verdict
```

`review` flags: `--name` (required), `--base <ref>`, `--scope auto|working-tree|branch` (default `auto`),
`--adversarial [focus...]` (a skeptical turn instead of the native review).

```bash
tools codex review --name reviewer --scope working-tree
tools codex review --name reviewer --base main --scope branch --adversarial auth rollback
```

#### Review mode (`spawn --mode review`)

`--mode review` needs a base: `--base <ref>`, else the branch's PR target, else its upstream (never the branch's
own remote copy); the spawn prints which. It runs `git diff --numstat <base>...HEAD` in the worker's cwd (limited
to `--paths <path...>` when given) and refuses an empty diff. The worker's developer instructions carry the shared
worker contract, `reviewLines(effort)` from `src/utils/worker/contract.ts`, and the manifest
(`Files to review (N, +A -D)` and one line per file). The manifest pins the merge-base and head commits, so a steer
or an escalation reviews the same range after either branch moves. Pass `--pr <number>` to record an explicit PR
identity in detached reviews, post-merge ones included.

The tier is `--effort`, else the diff size: `high` up to 15 files and 800 changed lines, `xhigh` above. `max` runs
only when named. `low` (triage) and `medium` are refused unless `--allow-shallow`, because medium reviews spent 358
to 2,399 reasoning tokens whatever the diff size and missed defects the xhigh pass found. Above 60 files or 4,000
lines the spawn prints a split suggestion: one reviewer per folder with `--paths`, at xhigh, in parallel.

After each review turn the daemon runs the depth gate (`src/codex/lib/review/gate.ts`). It checks three things:

- Coverage: the `Files reviewed: n of N` line against the manifest. A binary file named with a reason is excused.
- Reasoning: reasoning tokens per 100 changed lines against the tier floor (high 100, xhigh and max 250). Measured
  on 2026-10-22 on a 6,200-line diff, medium spent about 40 and xhigh about 390. The floors are first guesses from
  one day of data; tune them from `tools codex reviews`.
- Shape: each finding reads `N. [Severity] path:line - defect. Scenario: ... Fix: ...`, then a `Ran:` line.

The first miss steers the same session once with the unread files. The second starts `<chain>-<next tier>` as a new
session (a steer cannot change a thread's effort), at step 2. A miss after that, or a miss at `max`, ends the review
`shallow`. A `low` review is always `shallow`, and a medium review with `--allow-shallow` is never tuned up. Each
decision also goes to the agents bus as a `review_gate` event.

#### The review ledger

Every review start, review turn and gate decision is one line of `~/.genesis-tools/codex/reviews.jsonl`.

```bash
# Every review, filtered; one row per review, with totals.
tools codex reviews \
  --since 24h \
  --pr 42 \
  --label "review-loop" \
  --effort xhigh \
  --verdict shallow \
  --name auth \
  --json

# One review: manifest, spend, coverage, reasoning per 100 lines, gate history.
tools codex review-depth reviewer --json

# The same checks for a session spawned without --mode review.
tools codex review-depth reviewer --base origin/master

# Backfill the ledger from sessions that ran before it.
tools codex reviews import reviewer reviewer-xhigh --base origin/master --json
```

Every filter of `reviews` is optional.

`--since` takes a duration back (`24h`, `7d`), `HH:MM` today, or a date. `--effort` is `low`, `medium`, `high`,
`xhigh` or `max`. `--verdict` is `pass`, `steered`, `escalated`, `shallow`, `imported` or `open`.

`reviews import` backfills sessions that ran before the ledger: a start line, one turn line per booked turn of the
worker cost ledger, and a gate line marked `imported: true`. Its verdict comes from the final agent message (from
the session's event log): `pass` for `Files reviewed: n of n`, `shallow` for fewer, `imported` with no such line.
The manifest uses the session's saved pinned commits when they exist, even if its cwd is gone. For older sessions
it reconstructs both HEAD and the chosen base from their reflogs at the session's start time, then diffs their
merge-base to that historical head. Missing reflogs, an unknown base or a removed cwd leave the counts null and the
scope unconfirmed; commit dates alone cannot establish when a ref moved. `--no-cwd-from-session` leaves every
manifest null. Named binary files with a reason get the same coverage exemption as live reviews. A session already
in the ledger is skipped, so a repeated import adds nothing.

### Messages to sessions

```bash
# Send into a RUNNING codex session through its own channel.
tools codex message <session> [text...]
# Steer an exact thread, or queue the text for it.
tools codex steer --session <id> --home <path> --prompt <text>
# Persist a message for an exact session; it counts as received only after an ack.
tools codex queue --session <id> --home <path> --prompt <text>
# Read the queue without claiming anything.
tools codex queue list --session <id> --home <path>
# Claim one message for a consumer, acknowledge it, or cancel one not yet offered.
tools codex queue offer <message-id> --consumer <id> --session <id> --home <path>
tools codex queue ack <message-id> --consumer <id> --session <id> --home <path>
tools codex queue cancel <message-id> --session <id> --home <path>
```

`--session` and `--home` belong to `queue` itself and are required on every `queue` call.

`message` sends through the agent's own channel, not by typing into its terminal. `<session>` is a session id
(8 or more characters), a session name, a `/rename` title, or part of the cmux tab or workspace title the session
runs in. Pass `-` as the text to read it from stdin. For Codex the channel is the codex queue on the shared
app-server, and the message runs after the current turn; it needs a TUI attached to that server (started with
`--remote` or the default daemon). Flags: `--dry-run` (resolve the session only), `--first`, `--allow-keystrokes`
(paste into the cmux tab when the agent has no structured channel), `--json`, and with `--wait`: `--wait-timeout`,
`--stall-timeout`, `--stream`, `--last <n>`, `--tools`, `--quiet`. `--wait` waits for the end of the answering
turn, so a recipient that keeps working holds it until `--wait-timeout`. `--priority` applies to Claude only. This
is not the agents bus: `tools agents message` sends to agents logged into a bus session.

`steer --session <id> --home <path>` addresses an exact native thread and its absolute source `CODEX_HOME`.
`--name` and `--session` are mutually exclusive. When one live owned daemon holds that thread in that home, the
text is steered into it. Otherwise it is persisted in the portable queue for a cooperative receiver
(`--queue-root` overrides the queue directory, `--idempotency-key` gives it a stable identity). `--force` requires
a live owned daemon and never starts a new owner. A guard that names another thread or home refuses before
anything is queued.

`queue` persists messages for an exact session, and a message counts as received only after its consumer
acknowledges it. `offer` claims one payload for a consumer, and offering is not receipt. `ack` must come from the
consumer that took the offer. `cancel` works only on a message that was not offered yet. `--idempotency-key` reuses
the same message only when its text is unchanged. Output is JSON.

### Codex homes and the desktop app

```bash
tools codex migrate-home                                   # dry run over every ~/.codex-* sibling
tools codex migrate-home --from ~/.codex-personal --to ~/.codex
tools codex migrate-home --from ~/.codex-personal,~/.codex-work --desktop --apply
tools codex migrate-home --json                            # machine-readable report
tools codex desktop patch                                  # the desktop app's patch status (same as status)
tools codex desktop patch list                             # the patches this tool knows
tools codex desktop patch apply tool-outputs --yes         # re-sign the app and write the patch
tools codex desktop patch revert --yes                     # restore the original bundle and signature
```

#### Merging Codex homes (`migrate-home`)

`migrate-home` folds the transcripts of other Codex homes into one home, so a plain `codex resume` and the Desktop
app see every past conversation in one place. It copies; it never moves and never unlinks.

`--from` takes a repeated flag or a comma-separated list. It defaults to every `~/.codex-*` sibling that holds a
`sessions/` directory, minus backups and the destination. `--to` defaults to `~/.codex`. Without `--apply`
nothing is written. In a TTY the command shows the plan and then asks; without a TTY it needs `--apply`.

Safety rules, all of them load-bearing:

- **A home in use does not block the copy, but a rollout being written does.** The copy only adds files no holder
  touches, so a live `codex` on either home is fine. A rollout a process still has open is left for a later run
  and listed as `LIVE, SKIPPED` with the pids. If `lsof` cannot answer, the answer is `unknown` and the run
  refuses: a home that might be live is treated as live. Two operations still refuse outright against a live
  process, because both pull something out from under it: `--archive-source` against a busy source, and
  `--desktop` when the destination's `.codex-global-state.json` is open (close the Desktop first).
- **A `--from` entry it cannot use is skipped, not fatal.** Naming the destination, or a home with no `sessions/`
  directory, is listed under "Skipped sources", and the other sources still migrate. The run only refuses when no
  source is usable at all.
- **It refuses on any native-id collision** instead of picking a winner. A rollout already at the same relative
  path with identical bytes is this command's own earlier run, which is what makes a repeat a no-op.
- **The destination is backed up first** by APFS clone into `~/.genesis-tools/codex/migrate-home/<stamp>/`, both
  `sessions/` and `.codex-global-state.json`. The source needs no backup because it is never touched.
- **Older backups are packed after each applied run.** The newest two runs stay folders while they are at most 14
  days old. Every other run becomes `<stamp>.zst` (tar inside seekable zstd, checked file by file against the
  folder before the folder is removed). The runs are APFS clones of each other, so removing one run while a newer
  one stays frees almost nothing; packing the old ones together is what frees their space. Restore a run with
  `tools compress unpack ~/.genesis-tools/codex/migrate-home/<stamp>.zst`.
- **Packed backups are capped when a run is applied.** A `<stamp>.zst` stays while it is among the newest 2 or
  younger than 14 days, whichever keeps more, and the newest always stays. Packed snapshots of about 0.2 GB each
  used to stay for ever. Change the cap with `migrateHome.backups` (see "Configuration"). A run whose pack is
  skipped (low disk) or fails its check never pushes an older `.zst` out. A dry run never deletes.
- **Every copy is verified** by size and SHA-256 before the run counts it. A `.jsonl.zst` is decompressed first, so
  both forms of one rollout compare equal.
- **The date tree is preserved verbatim.** Paths are never re-derived from the rollout header timestamp, which
  differs from the filename timestamp.
- **Thread names come with the transcripts, through both of the places Codex keeps them.** A name never lives in
  the rollout. `session_index.jsonl` is what this repository's history index reads, and `threads.name` in the
  home's `state_*.sqlite` is what the Codex TUI shows. Carrying only the first still opens the thread unnamed, and
  then the first thing you type into it becomes the thread's new name. Both are carried, for every thread whose
  rollout the destination now holds, an earlier run's copies included. A name the destination already has is
  never overwritten, so a rerun is a no-op and Codex's own rename always wins. Names for rollouts that are not
  there are left behind, and the state databases are backed up beside `sessions/` before anything is written.
- `--archive-source` renames each source `sessions/` to `sessions.migrated-<stamp>` after the copy verifies. It is
  off by default, and it still deletes nothing.

🛑 **A copy leaves the same conversation in two homes, and the history index counts both.** `session_metadata` is
keyed `(provider, native_id, source_home)` and `file_daily_stats` by the per-home source key. So after
`tools codex history index sync`, a copied rollout contributes its conversation, its messages and its tokens TWICE
to the history statistics, once per home. Verified on the live index: one Codex thread present in two homes
reported 2 conversations and 100 messages for a single day. Nothing is lost and nothing crashes; the totals are
inflated by the number of rollouts that now exist twice. Prevent it by taking the source home out of circulation
after the copy verifies (`--archive-source` renames its `sessions/`, which stops discovery finding it), or accept
the inflation until you do.

`--desktop` also merges `.codex-global-state.json`, which is what makes the sessions appear under the right
projects in the Codex Desktop app. Projects are merged **by normalised root path, never by id**: the destination
already held one project under a raw UUID beside nine under `local-<md5>`, so an id-keyed merge would add a second
entry for the same directory on every run. Unseen ids are appended to `project-order`. Thread assignments are taken
from the source only for threads the destination lacks, and are remapped onto the destination's project id.
`selected-project` is left alone. The merged file is written atomically.

What it does **not** carry: `auth.json`, `history.jsonl` (the up-arrow recall buffer), the per-home SQLite
databases, and `archived_sessions/`. Only `sessions/` is enumerated (both `rollout-*.jsonl` and the
`rollout-*.jsonl.zst` files Codex 0.164 compresses, copied as they are), so a source home's archived threads stay
where they are. ⚠️ `--archive-source` renames `sessions/` only, and a home without one is no longer discovered, so
an un-migrated `archived_sessions/` becomes invisible to later runs. Copy it by hand, or leave that source
unarchived.

⚠️ Two per-home SQLite databases matter more than the rest. `thread_history*.sqlite` holds the body of every
`history_mode: paginated` thread. A copied rollout finds no projection in the destination, so history reads the
rollout itself and reports `Paginated projection unavailable for native thread`. For a forked thread the rollout
replays its parent's turns, so the first prompt of such a session can read as the parent's. After a run, re-index
with `tools codex history index sync`. The index keys a session on `[provider, source home, native id]`, so a moved
rollout is a new key, and `session_metadata.source_home` no longer names the home it came from. The per-rollout
mapping of the original migration was recorded outside this repository and is not public.

#### Patching the desktop app (`desktop patch`, macOS only)

The Codex desktop app is `ChatGPT.app` with bundle id `com.openai.codex`. The tool looks for it in
`/Applications` and `~/Applications`; `--app <path>` names another copy. Today there is one patch:

- `tool-outputs`: tool output height, full shell commands, and grouped tool calls, chosen in the app's Settings.
  The height presets are App default, `16rem`, `24rem`, `40rem`, `70vh` and Full height.

Subcommands:

- `desktop patch` and `desktop patch status`: the app version, whether it runs, each patch's state and the backup.
  Flags: `--app <path>`, `--json`.
- `desktop patch list`: every known patch. Flag: `--json`.
- `desktop patch apply [ids...]`: turn patches on. Named ids are added to the active ones. With no names in a
  terminal, a picker shows every patch with the active ones checked; unchecking all of them restores the original.
  Flags: `--app <path>`, `--sign <identity>` (default `auto`: a Developer ID identity, else ad-hoc; `-` is always
  ad-hoc), `--yes`, `--json`.
- `desktop patch revert`: restore the original app bundle and signature. Flags: `--app <path>`, `--yes`, `--json`.

`apply` and `revert` write nothing without `--yes` (the picker's confirmation counts as one). They print the status
and the exact command instead, and exit 1. Before you apply:

- Quit Codex desktop. A running app keeps the old bundle in memory, so a running app is refused.
- Patching re-signs the app. macOS then treats it as a different program, so the privacy grants for ChatGPT must
  be given again until you revert.
- The original bundle is copied first into `~/.genesis-tools/codex/desktop-patch/<version>-<build>-<hash>/`, one
  backup per installed copy and build. Backups of other versions of the same app are removed when you apply, since
  each restores only its own version (about 1.5 GB per old version).
- After the patch, quit and reopen the app, then choose tool output, shell commands and grouped tool calls in its
  Settings.

### Embedding apps (T3 Code): `tools codex embed`

An app that runs codex as a provider (T3 Code) points its binary path at a launcher, and the launcher runs
`tools codex embed -- "$@"`. The account comes from the operand before `--`, else from `TOOLS_CODEX_EMBED_ACCOUNT`
(set per T3 provider instance): an account name, `auto`, or `proxy:<account>/<provider>`. The child process carries
`TOOLS_CODEX_ACCOUNT`, so `tools codex who` names its account, and a T3 child shows its thread as `t3:<thread>`.

- T3 runs `<launcher> app-server`. The launcher starts the real `codex app-server` in token-only mode and logs it
  in as the account over the app-server's own JSON-RPC right after T3's `initialized`; T3 never sees that request.
  The home's `auth.json` is never read or written for the login, and the vault answers token refreshes.
- `--version`, `app-server --help` and `exec` go to the real binary unchanged. `exec` (T3's text generation) still
  bills the login in `auth.json`.
- `embed` serves the app-server on stdio only. It refuses `--listen` with any value other than `stdio://`,
  `--startup-sign-out`, and a `-c`/`--config` override of a login key it sets itself (`model_provider`, `profile`,
  `cli_auth_credentials_store`, `forced_login_method`, `chatgpt_base_url`, `openai_base_url`).
- The app-server subcommands that only print (`help`, `generate-ts`, `generate-json-schema`) go to the real
  binary. Every other app-server subcommand is refused.
- `proxy:` is refused: the ai-proxy does not serve the app-server protocol.
- `auto` cannot keep the account a resumed thread last ran on (the Claude embed can, because its resume id is on
  the argv). T3 names the thread later, in `thread/resume` over the app-server's stdin, after the launcher has
  logged the app-server in, and one app-server can serve several threads.

`tools t3 launchers install` writes the launchers, and `tools t3 providers add|sync` writes the T3 instances (see
[the t3 README](../t3/README.md)).

## How it works

- **The Codex CLI.** Every terminal, worker and embed runs the real `codex` binary. It is found on `PATH`, then in
  `~/.bun/bin`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. `run` needs version 0.153.4 or newer.
- **Accounts.** Accounts live in `~/.genesis-tools/ai/config.json` (provider `openai-sub`), and their OAuth grants
  live in the encrypted vault `~/.genesis-tools/security/vault.json`. A launch hands the tokens to a private
  app-server in memory; it never swaps the shared home's `auth.json`.
- **Codex homes.** The shared home is `~/.codex` (or `--home`). Its `sessions/`, `session_index.jsonl`,
  `state_*.sqlite`, `thread_history*.sqlite`, `models_cache.json` and `.codex-global-state.json` belong to Codex.
  `migrate-home` is the command that writes into them directly, and it backs the destination up first.
- **Workers.** Each worker is a detached daemon (`src/codex/daemon.ts`) that drives one `codex app-server`. Its
  files are in `~/.genesis-tools/codex/sessions/`: `<name>.meta.json` (status, thread id, pending approvals),
  `<name>.jsonl` (the event log), `<name>.daemon.log`, `<name>.control.jsonl` (the control channel),
  `<name>.launch.json` and `<name>.response.<id>.json`.
- **Ledgers and backups.** `~/.genesis-tools/codex/reviews.jsonl` (the review ledger),
  `~/.genesis-tools/codex/migrate-home/` (destination backups), `~/.genesis-tools/codex/desktop-patch/` (original
  desktop bundles).
- **Queued messages.** `~/.genesis-tools/agent-messages/` holds the portable session queue (`--queue-root`
  overrides it).
- **History.** The shared index is `~/.genesis-tools/claude-history/index.db`; the text stays in the native files.
- **Other tools it calls.** `tools agents` (the bus a worker reports to), cmux (for `who`, `cmux` and
  `message --allow-keystrokes`), `lsof` (the live-rollout check in `migrate-home`) and `codesign` (`desktop patch`).
- **What costs money.** Every turn of a terminal or of a worker with `--account`, and each `warmup` request, use
  the quota of the ChatGPT subscription account that runs it. `exec` from an embedded app, and a worker without
  `--account`, bill the login stored in the home's `auth.json`. `usage`, `history`, `models` and every read of a
  session send no model request.
- **Mac needs.** `desktop patch` and Computer Use are macOS only. Computer Use needs the official runtime in
  `ChatGPT.app` and its helper in the shared home, plus the macOS permissions it asks for.

## Configuration

`~/.genesis-tools/codex/config.json` holds one setting today:

```json
{
  "migrateHome": {
    "backups": { "keepArchives": 2, "keepArchiveDays": 14 }
  }
}
```

`keepArchives` is how many packed `migrate-home` snapshots always stay (the newest always stays, so 0 keeps 1), and
`keepArchiveDays` keeps every snapshot younger than that. A negative or non-numeric value falls back to the
default.

Environment variables:

| Variable | Effect |
| --- | --- |
| `CODEX_HOME` | Native Codex home for `login --import-native` and a worker without `--home`; `run` ignores it |
| `TOOLS_CODEX_EMBED_ACCOUNT` | The account of `tools codex embed` when no operand names one |
| `TOOLS_CODEX_ACCOUNT` | Set on every child `tools codex` launches; `who` reads it |
| `RUN_INTEGRATION=1` | Enables the installed-binary protocol tests |

Accounts are managed with `tools codex login`, `tools ai accounts` and `tools ai config account`. See
[the ai README](../ai/README.md).

## For agents

- **JSON.** `--json` works on `who`, `cmux focus`, `cmux send`, `usage`, `warmup`, `models`, `history` (also
  `--format json`), `history index`, `status`, `sessions`, `steer`, `wait`, `message`, `requests`, `request`,
  `reviews`, `reviews import`, `review-depth`, `migrate-home` and every `desktop patch` subcommand. `queue` always
  prints JSON.
  `spawn` returns its sandbox `warnings` in its JSON result.
- **Exit codes of `wait`** (and of `message --wait`): 0 the turn ended, 1 error, 3 stalled (a running turn wrote
  nothing for `--stall-timeout`), 4 the turn failed (an API outage, a failed compaction, a model at capacity; it
  did no work and carries the message in `error`), 124 `--timeout`. A turn that ended on a question for the user
  also exits 0: read `asksQuestion` in `--json`, and never answer a design question for the human. A question the
  agent asks while it keeps working does not end the wait; it is listed in `questions` when the turn ends.
- **`desktop patch apply` and `revert`** exit 1 when they need `--yes`, and print the command that would apply.
- **Skills.** [handoff-to](../../plugins/genesis-tools/skills/handoff-to/SKILL.md) picks a worker and its
  [Codex reference](../../plugins/genesis-tools/skills/handoff-to/references/codex.md) is the full worker recipe
  (spawn, checkpoint contract, steering, approvals, verification).
  [agents-talk](../../plugins/genesis-tools/skills/agents-talk/SKILL.md) starts the `lead` listener that approval
  requests go to; Codex itself must never invoke it.
  [claude-history](../../plugins/genesis-tools/skills/claude-history/SKILL.md) explains history search and resume
  across Claude, Codex and Grok.
- **Testing.** The installed-binary protocol tests use synthetic credentials and temporary homes:

```bash
RUN_INTEGRATION=1 bun run test src/codex/lib/terminal-server.test.ts
```

Sources: [app-server protocol](https://learn.chatgpt.com/docs/app-server),
[external-token API declaration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs).

## Troubleshooting

- **`Account-bound terminals require Codex CLI 0.153.4 or newer`.** The installed `codex` is too old. Update it,
  and check which binary is found (`codex --version`).
- **`Account-bound Codex does not accept --remote, --config/-c or --profile/-p overrides`.** A native argument after
  `--` would escape the account. Drop it; set the model with `--model` and the home with `--home`.
- **`Use tools codex login separately; this command starts an account-bound terminal`.** A native non-TUI
  subcommand (`login`, `exec`, `mcp` and similar) followed `--`. Run it outside `tools codex run`.
- **`Codex refused to resume that thread: another process is already writing to it`.** Codex allows one writer
  per thread. The message names the lock (`<home>/thread-writer-locks/<thread>.lock`) and, when `lsof` can tell,
  the process that holds it. Close the other Codex window on that thread or wait for it to exit. When the message
  says the lock is free now, run the same command again.
- **`auto found no codex account with headroom in the usage cache`.** Name the account, or refresh the cache with
  `tools codex usage`.
- **`A parent agents session is required`.** `spawn` ran outside a Claude Code, Codex or grok session. Pass
  `--session <id>`, or `--no-agents`.
- **`--no-skills cannot be honoured: codex has no skills/rules isolation control`** (or `--no-rules`). Codex
  cannot hide your skills or rules, so the spawn refuses the flag. Drop it, and spawn with a lean `--home <dir>`
  when the worker must load less (see
  [the handoff-to Codex reference](../../plugins/genesis-tools/skills/handoff-to/references/codex.md)).
- **`recipient "lead" not registered in this session`** in a worker's log. Nobody listens as `lead`, so its bus
  messages (approval requests too) go nowhere. Start the lead listener before the spawn (the agents-talk skill), or
  read the requests with `tools codex requests`.
- **A `--write ask` or `allow` worker cannot commit, run `ps`, or `bun install`.** The workspace-write sandbox
  forbids it. Approve the commit under `ask`, run `bun install` before the spawn, or use `--write full` in a
  throwaway worktree.
- **`--write full refuses <root>: it is a main checkout`.** Make a linked worktree
  (`git -C <root> worktree add -b <branch> <path>`) and spawn with `--cwd <path>`.
- **`--effort low` or `medium` is refused for a review.** Omit `--effort` to get high or xhigh from the diff size,
  or pass `--allow-shallow`.
- **`Pending approval not found: <id>`.** The request was already answered, by the CLI or over the bus.
- **A worker's thread is missing from the Codex Desktop sidebar.** Desktop re-reads its thread list only on a
  window load or a reconnect. Reload the window or restart Desktop, and start the worker in a folder the project
  owns.
- **History counts doubled after `migrate-home`.** The same conversation now lives in two homes. Run
  `tools codex migrate-home --from <source> --archive-source --apply` (or rename the source `sessions/` yourself),
  then `tools codex history index sync`. Without `--apply` nothing is written, and a repeat run with nothing left
  to copy returns before it offers to apply.
- **`Paginated projection unavailable for native thread`.** The rollout was copied without its
  `thread_history*.sqlite` projection. History falls back to the rollout itself; nothing is lost.
- **`Quit Codex desktop before patching it`.** Quit the app (also from the menu bar), then apply again.
- **`This app is already patched, but the original backup is missing`.** Reinstall Codex desktop, then apply
  again.
- **`This Codex build is missing <needles>; no patch was applied`.** The new app version changed the markup the
  patch targets. Nothing was written.
- **ChatGPT lost its screen, accessibility or other privacy grants.** The patched app has a new signature. Grant
  them again, or run `tools codex desktop patch revert --yes`.

## Related

- [tools ai](../ai/README.md): accounts, `ai usage`, `ai warmup` and `ai accounts discover`.
- [tools agents](../agents/README.md): the bus a worker reports to and the lead listens on.
- [tools claude](../claude/README.md) and [tools grok](../grok/README.md): the same shared verbs for the other
  agents.
- [tools t3](../t3/README.md): the T3 Code launchers and provider instances behind `tools codex embed`.
- [tools cmux](../cmux/README.md): the terminal panes `who`, `cmux` and `message --allow-keystrokes` work with.
- [tools compress](../compress/README.md): `compress unpack` restores a packed `migrate-home` backup.

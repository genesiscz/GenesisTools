# tools grok

Run xAI's `grok` CLI as one of your Grok accounts in the interactive terminal (the TUI), with indexed search to reopen
old sessions, or drive it as an isolated headless worker, one blocking turn at a time. It is the grok counterpart of
`tools codex` and `tools claude`, and it shares their verbs.

## Quick start

```bash
# Log in to SuperGrok in the browser and save the login as the account "work", in ~/.grok (what workers bill)
tools grok login work --home ~/.grok

# Open the grok TUI as that account (omit the name for a picker, or pass auto)
tools grok run work

# Find an old session by id, title or content, and reopen it
tools grok resume "auth callback"

# Start a headless worker: turn 1 of a new session (blocks for minutes)
tools grok spawn --name fix-auth --cwd ~/Projects/app --prompt-file ./brief.md

# Send the next instruction to the same session (blocks for minutes)
tools grok steer --name fix-auth --prompt-file ./next.md

# Read the last turn's transcript, one block per model call
tools grok read --name fix-auth --format compact
```

A worker bills the login file `~/.grok/auth.json`, not the vault. Create that file once with
`tools grok login work --home ~/.grok` (or the native `grok login`), or spawn with `--auth api-key`.

## Commands

Every command takes `--help`. The groups below hold every command the tool registers.

### Interactive terminal (TUI)

```bash
tools grok run [account] [-- <native args>]   # open the TUI as an account; alias: start
tools grok resume [query]                     # reopen a session by id, title or content (bare: grok's own picker)
```

| `run` flag | What it does |
|---|---|
| `[account]` | An account name, or `auto` to rank accounts by cached usage. A picker opens when you omit it. |
| `-r, --resume [query]` | Bare: grok's native picker. With a query: an indexed search by id, title or content. |
| `-c, --continue` | Continue the most recent session in this directory. |
| `--all` | With `--resume`, search every project, not only this directory. |
| `-m, --model <model>` | Model id or alias. |
| `--cwd <path>` | Working directory. |
| `--leader-socket <path>` | Run the session in a shared Grok leader on this socket. It starts one when none answers. |
| `--session-id <uuid>` | The id a new conversation gets. Ignored when you resume or continue. |
| `-- <args>` | Everything after `--` goes to the `grok` binary unchanged. |

`resume` takes `--account <name>` (a picker when omitted), `-l, --list` (print the matches and launch nothing),
`-a, --all`, `-n, --limit <n>` (default 20), `-m, --model <model>` and `--cwd <path>`. `run --resume <query>` also
takes `--list` and `--limit`, which its help hides.

### History search

```bash
tools grok history [query]                               # search grok conversations, this project by default
tools grok history index [sync|rebuild|status] [--json]  # the shared index; a bare `index` means sync
```

| `history` flag | What it does |
|---|---|
| `--all`, `-p, --project <name>`, `--cwd <path>` | Scope: every project, a project leaf name, or one directory |
| `--since <date>`, `--until <date>` | Date range (`'7 days ago'`, `yesterday`) |
| `--conv-date <date>`, `--conv-date-until <date>` | Range of the conversation start date |
| `--exact`, `--regex`, `--sort-relevance` | Match mode (fuzzy by default) and ranking |
| `-f, --file <pattern>` (or `--files`) | Match file paths and tool inputs (repeatable) |
| `-t, --tool <name>` | Match tool names, tool results included |
| `--commit <hash>`, `--commit-msg <text>` | Find recorded commit hashes or commit messages |
| `--summary-only`, `--list-summaries` | Search titles, summaries and first prompts; or list the topics |
| `--agents-only`, `--exclude-agents` | Only subagent conversations, or none |
| `--exclude-thinking` | Leave out reasoning text |
| `--exclude-session <id>`, `--exclude-current` | Leave out a session (repeatable), or this session |
| `-c, --context <n>` | Messages before and after each match (default 0) |
| `-l, --limit <n>` | Number of results (default 20) |
| `--format [type]`, `--json` | `ai` (default) or `json` |
| `-i, --interactive` | Prompt for filters and pick a session (needs a TTY) |
| `-q, --query <text>` | The query as a flag: the only way to search for a word such as `index` |

```bash
tools grok history "callback" --all --sort-relevance
tools grok history --file src/auth.ts --tool read_file --context 2
tools grok history --since "7 days ago" --exclude-thinking --format json
```

### Headless workers

A worker has no daemon and no approval channel. You write the brief and check the result, and you drive it with a resume
loop: one blocking command per turn, and you steer between turns.

```bash
tools grok spawn --name <name> --cwd <dir> --prompt-file <file>   # turn 1 of a new session (blocks)
tools grok steer --name <name> --prompt-file <file>               # the next turn of that session (blocks)
tools grok read --name <name> [--turn <n>] [--format <fmt>]       # re-print a finished turn
tools grok tail --name <name> [--format <fmt>]                    # follow the running turn; stops when it ends
tools grok status [--name <name>] [--json]                        # one session; omit --name to list every session
tools grok sessions [--json]                                      # list every worker session
tools grok stop --name <name>                                     # kill the running turn; the session survives
tools grok interrupt --name <name>                                # the same as stop
```

| `spawn` flag | What it does |
|---|---|
| `--name <name>` | Session name, required. A name is claimed once; later turns use `steer`. |
| `--cwd <path>` | Working directory, required. It must exist and be a directory. |
| `--prompt-file <path>`, `--prompt <text>` | The brief (one of the two). A relative path resolves against your shell, not `--cwd`. |
| `-m, --model <model>` | Model for the session (default `grok-4.7`) |
| `--readonly` | Review mode: only `read_file`, `list_dir` and `grep`, no write or terminal tools |
| `--auth <mode>` | `subscription` or `api-key` (default: `subscription` when the login file exists) |
| `--worker-home <path>` | A `GROK_HOME` of its own, for parallel or test runs |
| `--skills`, `--no-skills` | Load or hide your personal skills (default: load) |
| `--rules`, `--no-rules` | Load or hide your personal rules (default: load) |
| `--label <text>` | Tag every cost-ledger row of the session, for example `review-loop pr42` |

| `steer` flag | What it does |
|---|---|
| `--name <name>` | Session name, required |
| `--prompt-file <path>`, `--prompt <text>` | The instruction (one of the two) |
| `--readonly`, `--writable` | Switch the session to read-only, or back to writable, from this turn on |
| `--skills`, `--no-skills` | Load or hide your skills from this turn on |
| `--rules`, `--no-rules` | Load or hide your rules from this turn on |
| `--json` | Print a machine-readable receipt of the turn |
| `--expect-session <id>` | Refuse to deliver when the session id changed |
| `--expect-home <path>` | Refuse to deliver when the session's home changed |
| `--expect-turn <n>` | Refuse to deliver when the previous turn changed |

A mode or surface flag you leave out on `steer` keeps the session's earlier choice. The model is set once, at `spawn`.

`read` prints the turn report by default. `--format` picks the transcript instead: `compact`, `json`, `jsonl`,
`events` or `raw` (`--events` is short for `--format events`). `--turn <n>` picks a turn; the default is the latest,
and a running turn counts as the latest. `tail` takes the same `--format` (default `compact`). Both take
`--thoughts none|short|full` for the reasoning in the `compact` and `events` formats.

Write the brief to a file. In an inline `--prompt '...'` an apostrophe closes the quote, and the shell parses the rest
as arguments. A file has no quoting rules, and grok reads it by path, so a long brief never passes through argv.

### Live sessions

```bash
tools grok who [--json] [--all]                      # live grok processes, the account each bills; alias: active
tools grok wait <session> [--timeout <s>] [--json]   # block until a session's current turn ends
tools grok message <session> <text> --allow-keystrokes --wait   # paste into its cmux tab, then print the reply
tools grok cmux focus <session>                      # focus the cmux pane the session is open in
tools grok cmux send <session> <text>                # its Grok leader first, else type into its pane and press Enter
```

- `who` reads the account from `TOOLS_GROK_ACCOUNT` in each process's environment. `native?` means a process started
  outside `tools grok run`. It also shows the session and the cmux tab, and a T3 Code child as `t3` (T3 Code passes no
  thread id to a grok process). `--all`
  adds helper processes.
- `wait` reads the transcript and never scrapes the pane. `<session>` is a session id (8 or more characters), a
  transcript path, a cmux surface title or a `/rename` title. Flags: `--timeout <seconds>` (default: wait for ever),
  `--stall-timeout <seconds>` (default 900, 0 never), `--next` (an idle session waits for its next turn instead of
  returning), `--stream`, `--json`, `--first` (take the newest of several title matches), `--last <n>`, `--tools`,
  `--quiet`.
- `message` takes the same session forms, plus a session name or part of the cmux tab or workspace title. Pass `-` as
  the text to read it from stdin. Grok has no structured channel for it, so it needs `--allow-keystrokes`, which
  pastes with `cmux paste --submit` (that refuses over a draft or an open dialog). `--wait` waits for the turn that
  answers and prints the reply, with `--wait-timeout`, `--stall-timeout`, `--stream`, `--last`, `--tools` and
  `--quiet`. `--dry-run` resolves the session and sends nothing. `--priority` applies to Claude only.
- `cmux focus` takes `--no-activate`, `--first`, `--include-self`, `--dry-run` and `--json`.
- `cmux send` takes `--no-enter`, `--enter-delay <ms>` (default 500), `--first`, `--include-self`, `--dry-run`,
  `--json` and `--timeout <seconds>` (exit 124). `--dry-run` and `--no-enter` skip the leader and use the pane only,
  because a leader prompt is always submitted.

### Message queue

```bash
tools grok queue --session <id> --home <abs dir> --prompt-file <file>   # persist a message for that exact session
tools grok queue --session <id> --home <abs dir> list                   # read the queue, claim nothing
tools grok queue --session <id> --home <abs dir> offer <msg> --consumer <agent>   # claim one payload for a consumer
tools grok queue --session <id> --home <abs dir> ack <msg> --consumer <agent>     # acknowledge after reading it
tools grok queue --session <id> --home <abs dir> cancel <msg>                     # cancel a message not yet offered
```

`--session` is the exact native session id and `--home` the absolute source home of that session; both are required.
A message counts as received only after its consumer acknowledges it, and an offer is not an acknowledgement.
`--idempotency-key <key>` reuses a message only when its text is unchanged. `--queue-root <path>` moves the queue
directory. Output is JSON.

### Accounts and usage

```bash
tools grok login [name]                       # browser login to SuperGrok, the grant saved in the vault
tools grok login [name] --home ~/.grok        # the same login, written into that home's auth.json
tools grok login [name] --auth-file <path>    # bind a credential file that already exists (no browser)
tools grok login [name] --import-native       # bind the native CLI's current auth.json; fails when it is missing
tools grok usage [--json] [--range 24h]       # the shared usage dashboard, pinned to Grok
tools grok warmup [account...] [--all] [--json]   # one tiny request per account to start its window
```

`usage` also takes `--account <name...>` and `--fresh` (a live poll that skips the shared cache only when the cached
reading is older than 300 s: the 300 s floor stays). `--range` is one of
`60m`, `6h`, `24h` or `7d`. Without `--json` it opens a TUI. `warmup --all` takes every enabled account without a
prompt. An account without a 5-hour limit is warmed only when its weekly window is idle.

### Embedding apps

```bash
tools grok embed [account] -- <native args>   # the binary an embedding app (T3 Code) runs, as one account
```

See [Embedding apps (T3 Code)](#embedding-apps-t3-code) below.

## How it works

### Where data lives

```text
~/.genesis-tools/grok/sessions/<name>.meta.json      worker record: session uuid, cwd, home, mode, auth, turns
~/.genesis-tools/grok/sessions/<name>.turn<N>.jsonl  turn N transcript (grok's streaming-json NDJSON)
~/.genesis-tools/grok/sessions/<name>.turn<N>.err    turn N stderr
~/.genesis-tools/grok/worker-home/                   GROK_HOME of workers that load your skills
~/.genesis-tools/grok/worker-home-noskills/          GROK_HOME of workers started with --no-skills
~/.genesis-tools/grok/auth/                          a vault account's login file, kept only while grok runs
~/.genesis-tools/grok/leaders/                       per-account leader sockets of `tools cmux agents new grok`
~/.genesis-tools/workers/cost-ledger.jsonl           one cost row per finished worker turn
~/.genesis-tools/claude-history/index.db             history index, shared with Claude and Codex
~/.genesis-tools/agent-messages/                     `tools grok queue` messages
~/.genesis-tools/ai/config.json                      grok-sub accounts
~/.genesis-tools/security/vault.json                 the encrypted vault that holds login grants
~/.grok/                                             grok's own home: auth.json, sessions/, leader.sock
```

`GENESIS_TOOLS_HOME` moves `~/.genesis-tools`, and `GROK_HOME` moves `~/.grok`.

There are two session stores, and they are not the same inventory. `tools grok history` and `run --resume` list the
TUI sessions under `~/.grok/sessions` (and the same layout inside the worker homes). `tools grok sessions` lists the
headless workers, one `<name>.meta.json` each.

### What it needs and what it costs

- The `grok` binary on `PATH`. The tool reads the live `PATH` on every call, so a wrapper that prepends a directory
  works. It spawns the binary directly, with no shell, so a zsh `grok` function cannot interfere.
- cmux for `cmux focus`, `cmux send` and `message --allow-keystrokes`. A browser and a TTY for `login`. No macOS
  permissions.
- Money. TUI sessions bill the account's SuperGrok allowance. Worker turns bill the allowance (`subscription`) or the metered
  xAI API team (`api-key`, through `XAI_API_KEY`). `warmup` sends one tiny request per account. `usage` reads xAI's billing
  endpoint (`/billing?format=credits`, the call the CLI's own `/usage` pane makes), at most once per 300 s, also with
  `--fresh`. It shows the allowance as whole percent over the current period (a rolling week on every account
  seen so far), split by product, plus a pay-as-you-go line when the account has on-demand spend.
- Every finished worker turn books one row in the cost ledger, and the turn report prints its cost line.
  `tools ai-spend workers` reads the ledger, and `--by label` groups it by `spawn --label`.

### The headless worker

A turn is one `grok` process. `spawn` checks the brief, the `--cwd` and the binary before it claims the name, so a
typo does not burn the name. Then it runs `grok` with `--session-id <uuid>` on turn 1 (or `--resume <uuid>` on later
turns), `--cwd`, `--output-format streaming-json`, the permission flags and the worker contract. When the turn ends it
parses the stream, compares the worktree, books the cost and prints the turn.

- **Isolation is per surface, and the surfaces are ON by default.** Workers get
  `GROK_HOME=~/.genesis-tools/grok/worker-home`. Hooks, MCP servers and session pickup from `~/.claude` are switched
  off unconditionally (side effects and credentials), even when your shell exports the toggles. Your personal skills
  (`~/.agents/skills`, `~/.claude/skills`) and rules (`~/.claude` rules and `CLAUDE.md`) load unless you pass
  `--no-skills` or `--no-rules`. The choice is stored in the session record, and a steer without the flags keeps it.
- **`--no-skills` is a property of the worker home.** grok has no environment toggle for `~/.agents/skills`, so a
  session started with `--no-skills` runs in `~/.genesis-tools/grok/worker-home-noskills`, whose `config.toml` carries
  a marked `[skills] ignore` block. The default home never carries it. Two shared homes with one fixed policy each mean
  that parallel sessions with opposite choices never rewrite the file under each other. A `steer --skills` on such a
  session flips only the `~/.claude` tier, because the home cannot change mid-session (grok keys sessions by cwd
  inside it). A home you name with `--worker-home` follows the session's own choice.
- **The worker contract.** Every turn carries the shared contract (`src/utils/worker/contract.ts`) as `--rules`: checkpoints, the
  `RESULT/AT/CHANGED/VERIFY/OPEN` report shape, and a note that interactive rituals such as `tools say` do not apply to
  a worker. `RESULT` is `done`, `stopped-at-checkpoint`, `blocked` or `failed`.
- **`--worker-home` does not move the session records.** They stay under `~/.genesis-tools/grok/sessions/`, so
  `tools grok sessions` lists every worker, and two runs that share a `--name` share one record whatever their home.
  Keep one home for the whole session: grok keys sessions by cwd inside it.
- **Project config still loads.** `CLAUDE.md` and a `.grok/` directory in the target repo (MCP servers, hooks,
  permission rules) load as usual. `GROK_HOME` redirects user state only. When that is not what you want, point `--cwd`
  at a scratch folder with no `CLAUDE.md` and no `.grok/`. A worktree of the same repository is not enough: it checks
  out the tracked `CLAUDE.md` and `.grok/` too, so check it for both before you use it.
- **Session bookkeeping.** The session uuid and cwd live in `<name>.meta.json`. `steer` resumes with the identical
  `--cwd` automatically, because grok keys sessions by cwd. When turn 1 died before grok created the session, the
  next steer starts it again under the same id.
- **Sticky permission flags.** The grok CLI forgets `--tools` and `--always-approve` on every `--resume`. The harness
  re-arms the read-only allowlist on each steer of a `--readonly` session, and `--always-approve` on each writable
  turn. `steer --writable` switches a session back to writable on purpose.
- **Honest exit codes.** The grok CLI exits 0 even when a turn dies. `tools grok` parses the stream and exits 1 when no
  terminal `end` event is present.
- **Stop by session uuid.** `stop` sends SIGTERM only to grok processes whose command line carries the session uuid
  (`--session-id` on turn 1, `--resume` later), so a recycled pid is never hit. The turn then reports `DIED` with
  exit 143 and exits 1, and the next steer resumes the session. Never `pkill -f "grok .*--cwd <path>"` by hand: a cwd
  pattern matches every session in that project, and `grok` matches your own shell and editor too.
- **One claim per name, one transcript per turn.** `spawn` reserves the session name with `O_EXCL`, and each turn
  reserves its own log file the same way, so two concurrent invocations cannot both start turn 1 or truncate each
  other's transcript. A turn also holds a lock on the session for its whole run.
- **Swarm membership.** `spawn` pins the agents-bus session of the caller once, and every turn exports it as
  `GT_RENDEZVOUS_SESSION`, so `tools agents` commands inside the worker join the parent's swarm.
- **The prompt never reaches the log.** The day log records the shape of each invocation with the prompt blanked.

When a turn ends, the harness prints one status line on stderr: backend, name, turn, `completed` or `DIED`, the tool
calls counted by name, and the worker's `RESULT:` line. The worker's report goes to stdout, so
`tools grok spawn ... > report.md` captures exactly what the worker said. Then stderr gets the first 600 characters of
grok's stderr, the worktree delta, the cost line and the command that renders the transcript. It never lists tool
calls one per line.

"The turn ended" is not "the task got done". A worker that stops cleanly halfway prints the same success line as one
that finished. So after each writable turn in a git repo, the harness prints what the turn changed:

```text
turn 2 changed 1 path(s); 1 dirty in total
turn 1 changed NOTHING in ~/Projects/app ...
```

The second line is a warning ("the turn ended, but the task may be unfinished"): check the work, then steer the
worker to continue. The delta is absent for `--readonly` sessions, outside a git repo, and for a replay with `read`
(a replay has no before and after snapshot). A turn that committed says how many commits it made.

The transcript has one door for every backend: `tools grok read --format <fmt>` here, or
`tools ai sessions tail <name> --provider grok [--follow]`. `compact` renders a 950-line turn log in about 80 lines,
one numbered block per model call with the tool results folded in. `jsonl` is one JSON turn per line for a pipe,
`events` is the shared worker-event vocabulary, and `raw` is the CLI's own NDJSON.

### Safety model (re-verified against grok CLI 1.0.52, 2026-10-15)

- A writable turn runs with `--always-approve`. Nobody can answer a permission prompt in a headless turn. Without the
  flag, grok sent a nested `sh -c` or a `;` chain through a 1-6 s gate, and a verdict other than "allow" came back as
  `cancelled` and ended the whole turn before the command ran. `--allow Bash` does not stop that gate.
- There is **no project jail**. The jail verified on grok 1.0.3 is gone: on 1.0.52 a write to a path under `$HOME` was
  allowed in 0 ms with and without `--always-approve`. Give a writable worker a disposable worktree. The `jail` label
  in `tools grok sessions` and the "project-jail mode" in `steer --help` only mean "writable".
- `--readonly` maps to the `--tools read_file,list_dir,grep` allowlist: the worker physically lacks edit and terminal
  tools. It also cannot write a report file or run a test, so its claims about runtime behavior come from reading.
- Do not hand-roll bare `grok` flags for safety. `--permission-mode plan` does not restrict headless runs, and
  `--disallowed-tools` silently keeps `run_terminal_command`.

### Authentication and billing

A worker never logs in for you, and neither does the TUI launch. `tools grok login` is the only login the tool
performs, and only when you run it.

**Workers.** `--auth` picks the credential, and the session record keeps the choice for every steer.

- `subscription` uses the login file of your own environment: `GROK_AUTH_PATH`, else `$GROK_HOME/auth.json`, by
  default `~/.grok/auth.json`. The worker's own home never holds a login, so the harness points `GROK_AUTH_PATH` at
  the real file, never a copy, and a token refresh cannot fork the credential. It also removes `XAI_API_KEY` and
  `GROK_CODE_XAI_API_KEY` from the worker, because the binary prefers an API key over its login file.
- `api-key` bills the metered xAI API team through `XAI_API_KEY`, which the worker inherits from your environment.
- Without `--auth`, a session uses `subscription` when the login file exists, else `api-key`. The default flipped on
  2026-09-04, after five workers billed the API key in silence and died on a 403 "used all available credits" while
  the subscription sat idle.
- A vault login (`tools grok login` with no flag) writes no file, so a worker cannot use it. For workers, log in with
  `tools grok login <name> --home ~/.grok` or the native `grok login`.
- `spawn --account` is refused: grok pins a login FILE, not an account. To bill another account's login, point
  `GROK_AUTH_PATH` at that account's `auth.json` and pass `--auth subscription`.

**The TUI.** `run`, `resume` and `embed` launch grok as an account. An account bound to a file (`login --home`,
`--auth-file` or `--import-native`) IS that file. Its home is the folder around the file when the file is named
`auth.json`, else the default home. A vault-only account has no file, so its grant is written to
`~/.genesis-tools/grok/auth/` for the session and removed when grok exits. Its sessions go to the default home, the
only tree the history readers walk. The child gets `GROK_HOME`, `GROK_AUTH_PATH`, no API key, and
`TOOLS_GROK_ACCOUNT` with the account name, which `who` reads back. `tools grok` stays the parent for the whole
session, so it can remove the grant after grok exits.

### TUI launch and resume

- Bare `--resume` (and bare `resume`) opens grok's own picker (`grok --resume`) as the account you pick, in that
  account's home. `-c` continues
  the most recent session in the directory.
- A query searches the history index. The picker also offers sessions that already run in a cmux tab, and picking one
  focuses that tab instead of starting a second copy. A resumed session launches as `grok -r <id>` with that session's
  own `GROK_HOME`, so a session from a worker home is not looked up in your personal home. A warning says so, and the
  session bills the account you picked.
- A resumed session opens in its recorded directory when that directory still exists, even with `--cwd`. When the
  recorded directory is gone, it opens in `--cwd` (default: the current directory) and prints a warning.
- TUI resume is not the worker. It never runs a worker turn and never changes the parent environment.
- `tools grok run --name <name> --cwd <dir>` is the worker's older spelling. It still routes to `spawn` and prints a
  notice. Without `--cwd` it is refused.

### The Grok leader

A TUI started with `--leader-socket <path>` runs its session inside a shared leader process (`grok --leader`). The
leader starts on that socket when none answers, and later TUIs join it. Another client on the socket can list the
session and prompt it, and the TUI shows the prompt and the answer as its own turn (live-tested on grok 1.0.70,
2026-10-30). `tools cmux agents new grok` starts one leader per account under `~/.genesis-tools/grok/leaders/`, so a
second session of that account joins the first one's leader. When that path is too long for a macOS socket (a long
`GENESIS_TOOLS_HOME`), the socket goes under `/tmp/gt-grok-leaders-<uid>/` instead. It never uses the default
`~/.grok/leader.sock`, which may be your own leader.

`cmux send` tries the leader before the pane. When the leader matched the session but its answer is unknown (a timeout
or an error), `cmux send` exits 1 with "The text may have been received; check the session before sending again." and
does not type into the pane. `tools question` delivers a decision answer to the worker that owns the
session first (one `steer`), then to the leader, then to the pane. A leader lookup asks the sockets the session's cmux
record names, then the default `~/.grok/leader.sock`. A socket file that does not exist is skipped, so asking never
starts a leader. When no leader holds the session, the text goes to the pane.

`message` does not use the leader. On grok 1.0.44 (checked 2026-10-08) a plain TUI held no listening socket, so
`message` reports no structured channel and needs `--allow-keystrokes`.

A vault-only account cannot run a leader yet, because the grant's owner exits with its first TUI. Bind a file with
`login --auth-file` or `--home` first.

### History index

`history` uses the same provider-scoped index and search service as Claude and Codex. It searches user and assistant
text, tool calls and results, paths, and the session metadata it has. The current project is the default scope, and
`--all` widens it to other Grok projects. It never resumes a session from another provider.

A search or listing builds the index on first use and syncs changes on its own, so no manual indexing step is needed.
`history index sync` and `rebuild` are optional; they also refresh the message statistics. `status` is read-only.
Indexing does not import credentials or migrate native conversations.

The metadata and statistics share `~/.genesis-tools/claude-history/index.db` with Claude and Codex. Chat text stays in
grok's own files. `updates.jsonl` is separate usage telemetry, and missing telemetry gives unknown token counts, not
zero. A rebuild keeps native transcripts, credentials and the historical usage observations in the shared database.
Never delete the whole database as a cache reset.

### Embedding apps (T3 Code)

An app that runs grok as a provider (T3 Code) points its binary path at a launcher, and the launcher runs
`tools grok embed -- "$@"`. The account comes from the operand before `--`, else from `TOOLS_GROK_EMBED_ACCOUNT` (set
per T3 provider instance): an account name or `auto`. The child carries `TOOLS_GROK_ACCOUNT`, so `tools grok who`
names its account, and a T3 child shows as `t3` (T3 Code passes no thread id to a grok process).

- T3 runs `<launcher> agent stdio` (ACP), with `--permission-mode` or `--always-approve`. The launcher runs the real
  grok with the account's auth file, or with a vault grant that it removes when grok exits. Nothing but grok's own
  output goes to stdout, because stdout is the ACP channel.
- `--version` and `--help` probes run with no account.
- `proxy:<account>/<provider>` is refused with exit 2, and so is a call without `--`.
- `auto` cannot keep the account a resumed session last ran on. (The Claude embed can, because its resume id is on
  the argv.) T3 names the session later, in ACP `session/load`, after grok has started as the account.

`tools t3 launchers install` writes the launchers, and `tools t3 providers add|sync` writes the T3 instances.

## Configuration

**Accounts.** `tools grok login [name]` saves a `grok-sub` account in `~/.genesis-tools/ai/config.json`. Choose one
mode: the vault login, `--import-native`, or `--home`/`--auth-file`. `--import-native` with a file flag is refused.

- No flag: xAI's own OIDC flow with PKCE in the browser, a loopback listener with a paste prompt as the fallback, and
  the grant stored in the vault. No Grok CLI needed. It needs a TTY.
- `--home <dir>`: the same browser login, written into `<dir>/auth.json`, so the native CLI can use it too. It needs a
  TTY.
- `--auth-file <file>`: bind a credential file that exists. No browser, so it works headless. When the file does not
  exist yet, the browser login writes it there, and that needs a TTY.
- `--import-native`: bind the native CLI's current file (`$GROK_HOME/auth.json`). It fails when the file is missing.

An account bound to a file follows that file. A later `grok login` on the native CLI rewrites the file, and every
account bound to it follows. The vault login has no file and does not move.

`login`, `usage` and `warmup` are doors onto the provider-neutral account core. The same code runs behind
`tools ai accounts login --provider grok`, `tools ai usage --provider grok` and `tools ai warmup`.

**Environment.**

| Variable | Effect |
|---|---|
| `GROK_HOME` | grok's own home (default `~/.grok`): `auth.json`, TUI sessions, `leader.sock` |
| `GROK_AUTH_PATH` | The login file a subscription worker bills (default `$GROK_HOME/auth.json`) |
| `XAI_API_KEY` | The metered xAI API key, used by `--auth api-key` workers |
| `TOOLS_GROK_EMBED_ACCOUNT` | The account `embed` runs as when no operand names one |
| `GENESIS_TOOLS_HOME` | Moves `~/.genesis-tools` (sandboxes, tests) |
| `PATH` | Where the `grok` binary is found, read on every call |

The tool sets these on its children, over your own values:

- `GROK_HOME` on every child: the worker home, the session's home, or the account's home.
- `GROK_AUTH_PATH` on subscription workers and on every account launch.
- `TOOLS_GROK_ACCOUNT` on TUI and embed launches.
- `GT_RENDEZVOUS_SESSION` on a worker started from an agents-bus session.
- On workers: `GROK_CLAUDE_MCPS_ENABLED=0`, `GROK_CLAUDE_HOOKS_ENABLED=0` and `GROK_CLAUDE_SESSIONS_ENABLED=0`, plus
  `GROK_CLAUDE_SKILLS_ENABLED`, `GROK_CLAUDE_RULES_ENABLED` and `GROK_CLAUDE_AGENTS_ENABLED` from the session's surface
  choice (`--no-rules` turns off the last two). These toggles switch off what grok picks up from `~/.claude`; they
  do not touch credentials.

**Worker home.** The harness writes `config.toml` in the worker home. A `--no-skills` home gets a marked block that
the harness owns:

```toml
[skills]
ignore = ["~/.agents", "~/.claude"]
```

## For agents

- `spawn` and `steer` block for the whole turn (minutes). In Claude Code, run them with Bash `run_in_background` and
  wait for the completion notification. In a harness without that, background the command yourself and poll
  `tools grok status --name <name>`.
- Never trust the report alone. Run the verification yourself and read `git diff` in the worker's cwd. A dead turn
  exits 1. A clean stop halfway exits 0, so read the worktree delta line too.
- `tools grok spawn ... 2>&1 | head -1` gives the status line with the worker's `RESULT:` value.
- `steer --json` prints a receipt: `{kind: "turn", backend, name, sessionId, sourceHome, turn, completed, exitCode}`,
  or `{kind: "rejected", ...}` when an `--expect-*` guard refused delivery. It exits 1 unless the turn completed with
  exit 0.
- `wait` exits 0 when the turn ended (a turn that ended on a question too: read `asksQuestion` in `--json`), 1 on an
  error, 2 on a usage error, 3 on a stall, 4 when the turn failed, and 124 on `--timeout`. `message --wait` uses the
  same codes.
- JSON output: `status --json`, `sessions --json`, `who --json`, `history --json`, `history index --json`,
  `usage --json`, `warmup --json`, `wait --json`, `message --json`, `cmux focus|send --json`, and `queue` (always).
- Absent verbs: `approve` and `deny` exist only to say "Not available" and exit 1, because grok has no approval
  channel.
- Skill: `gt:handoff-to`, then its `references/grok.md` (the readiness gate, the checkpoint contract, the
  verification discipline). For a long handoff, the `genesis-tools:agent-driver` subagent with `BACKEND: grok` runs
  the spawn, steer, read and verify loop. The `gt:claude-history` skill covers `tools grok history`.

## Troubleshooting

Nothing is rolled back when a turn fails, and that is deliberate: a dead turn's transcript is the evidence. Read it
with `tools grok read --name <name> --turn <n> --format compact`. It shows what the worker did, one block per model
call, and ends in the `✖ error:` line. The raw log and stderr are `<name>.turn<n>.jsonl` and `<name>.turn<n>.err`
under `~/.genesis-tools/grok/sessions/`. A turn that died mid-flight (no terminal `end` event) exits 1 and prints its
stderr. The session stays resumable, and `steer` starts the next turn number.

- **`grok CLI not found on PATH`.** The binary is missing. This check does not look at credentials.
- **`grok subscription login not found at <path>`.** The session uses `--auth subscription`, and the login file is
  missing. Run `tools grok login <name> --home ~/.grok` or the native `grok login`, or spawn with `--auth api-key`.
- **Turn 1 exits non-zero with auth text in `.err`.** The binary is present, but it is not authenticated. The binary
  check does not look at credentials, so the turn starts and then fails inside grok. Check the session's mode with
  `tools grok status --name <name> --json`.
- **A 403 "used all available credits".** The turn billed the API key team. Create the login file, or spawn with
  `--auth subscription`.
- **`Turn <n> ... already has a transcript`.** That turn number is reserved: another turn runs, or one died
  uncleanly. The reservation is what stops a second invocation from truncating the first one's transcript. Read turn
  `n` first, and remove its `.jsonl` only when you are sure no process still writes to it.
- **`Grok session '<name>' already exists`.** The name is claimed. Steer it, or pick another name.
- **`... still has turn <n> running (pid <p>)`.** A grok child of an earlier turn still runs. Wait for it, or run
  `tools grok stop --name <name>`.
- **`Failed to acquire file lock at ...turn.lock`.** Another turn of this session runs right now, and the wait for
  its lock gives up after 5 s. Follow that turn with `tail`, or stop it.
- **A session is missing from `sessions`, or `steer` says it is not found.** Its record lacks a field that a resume
  needs (`sessionId`, `cwd`, `workerHome`, `readOnly` or `turns`). It is skipped rather than shown as a resumable row,
  because a blank `sessionId` would start a new conversation under the old name. The name stays claimed.
- **`--cwd <path> does not exist`.** This is checked before the name is claimed, so the name stays free.
- **`turn <n> changed NOTHING in <cwd>`.** The turn ended, but the task may be unfinished. Check, then steer.
- **`message` reports no structured channel.** Pass `--allow-keystrokes` (the session must run in a cmux tab), or use
  `tools grok cmux send`, which tries the leader first.
- **`A shared Grok leader cannot use a vault-only account yet`.** Bind a file with `login --auth-file` or `--home`, or
  run without `--leader-socket`.
- **`Grok login needs a TTY`.** Run it in a terminal, or bind an existing file with `--auth-file`.
- **`spawn --account` is refused.** grok pins a login file, not an account. Use `--auth subscription` and point
  `GROK_AUTH_PATH` at that account's `auth.json`.

## Related

- [tools codex](../codex/README.md) and [tools claude](../claude/README.md): the same verbs for the other agents.
- [tools ai](../ai/README.md): `ai accounts login`, `ai usage` and `ai sessions tail`, the provider-neutral cores.
- [tools ai-spend](../ai-spend/README.md): `ai-spend workers` reads the worker cost ledger.
- [tools cmux](../cmux/README.md): `cmux agents new grok` opens a session in a background workspace, in a leader.
- [tools agents](../agents/README.md): the agents bus a worker joins through `GT_RENDEZVOUS_SESSION`.
- [tools question](../question/README.md): delivers a decision answer to a grok worker, its leader or its pane.
- [tools hub](../hub/README.md): shows the grok workers beside the other agents.
- [tools t3](../t3/README.md): writes the launchers and T3 instances that call `tools grok embed`.

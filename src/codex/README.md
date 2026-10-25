# `tools codex`

Run the native Codex terminal with a named subscription account and one shared
Codex environment, search native conversation history, or manage app-server workers.

## Login and account ownership

```bash
tools codex login work
tools ai codex login personal
tools ai accounts login work --provider codex
```

These use one login registration and shared account core. Ordinary login obtains a
new OAuth grant and stores it in the encrypted GenesisTools vault. Browser opening,
URL copying, pasted callback URLs, and cancellation use the same interaction helpers
as Claude login. `--broker` remains an alias for this default.

Explicit native-file modes remain available:

```bash
tools codex login work --import-native
tools codex login work --auth-file /path/to/profile/auth.json
tools codex login work --home /path/to/profile
```

`--import-native` binds the current `CODEX_HOME/auth.json` (or `~/.codex/auth.json`)
and fails if it is missing. An existing `--auth-file` is bound without OAuth or
rewriting it. An explicit home or missing auth-file destination keeps native-file
login behavior. Conflicting vault/native options are rejected before account writes.
Native file references keep the CLI as their refresh owner. Vault grants are refreshed
only through the common account binding, under the shared config/vault lock order.

Logging into a named account does not switch the desktop account or replace the
shared home's `auth.json`. Real profiles and existing credentials are never migrated
implicitly. Use `tools codex usage` or `tools ai usage --provider codex` for selected
account quotas; vault accounts do not need a native auth home for usage polling.

## Account-bound native terminals

```bash
tools codex run work --model astra
tools codex run work --model terra --resume
tools codex run work --model luna --resume "invoice parser"
tools codex run work --resume "invoice parser" --model sol
tools codex run --cwd ~/Dev/project --model astra work

# Native arguments remain available behind --.
tools codex run work -- resume <thread-id>
```

`run` (alias `start`) attaches the original terminal UI to a private local app-server.
Each launch has the selected account's authentication in memory and defaults to the
same real `~/.codex` for configuration, plugins and conversations. An inherited
`CODEX_HOME` does not select another target home; use `--home` explicitly if needed.

The account argument is matched by substring within `openai-sub` accounts, the same
rule `tools claude run` uses for its target: an exact id or account name wins first,
otherwise every whitespace/slash-separated token of what you typed must appear in an
enabled account's name (`work` matches `cdx-work`). A name that is also the exact name
of an account on a different provider never wins by accident — the match is scoped to
`openai-sub`. Several accounts matching is an error naming the candidates.
Requires Codex CLI 0.153.4 or newer and macOS or Linux. The external-token and native
remote-terminal interfaces are experimental upstream.

Aliases resolve centrally: `astra` → `gpt-6-astra`, `terra` → `gpt-5.6-terra`,
`luna` → `gpt-6-luna`, `sol` → `gpt-6.1-sol`. Full IDs and shared config model
aliases are accepted. A model alias cannot switch the selected account or provider.
Unsupported models surface the native error rather than silently selecting another.

Bare `--resume` opens the native picker. A query searches IDs first, then titles and
summaries, then transcript content. The current project is the default scope;
`--all` includes other projects of the same provider. Ambiguous non-interactive
queries fail instead of choosing the first result. The interactive launcher itself
requires a TTY; use `spawn --account` for managed workers.

Persistent login/logout, configuration writes, alternate providers and non-TUI
subcommands are blocked on the account-bound connection. Running processes retain
immutable account/workspace identity across renames and reject disabled or removed
accounts. Exit stops the backend and removes its private socket. Resume through the
account wrapper rather than reusing the temporary raw socket printed by native Codex.

## Indexed history and legacy copies

A full native UUID passed to `--resume` is an exact lookup across projects; it never falls back to a transcript that merely mentions that ID. Free-text queries remain project-scoped unless `--all` is supplied. When the same ID is retained in multiple homes, the target shared home's copy is preferred. A canonical archived session is unarchived through the native API before the TUI resumes it.

Searches/listings automatically build the index on first use and synchronize changed sources. No manual indexing command is required. Explicit sync/rebuild are optional maintenance; status is read-only. Indexing never imports credentials or migrates source conversations.

```bash
tools codex history "invoice parser" --all --sort-relevance
tools codex history --file src/auth.ts --since "7 days ago" --context 2
tools codex history --tool exec_command --exclude-thinking --format json
tools codex history index status
tools codex history index sync
tools codex history index rebuild
```

Claude, Codex and Grok share `~/.genesis-tools/claude-history/index.db` through
provider readers. SQLite keeps bounded metadata and aggregate statistics; user and
assistant text, tools/results and original context are read from native sources.
Archived sessions and legacy Codex profile homes remain discoverable. `--summary-only`,
`--exact`, `--regex`, session/agent exclusions, date filters and JSON output are
available. History reads do not resolve or refresh credentials. Native source files
remain authoritative; rebuilding history does not edit them or the shared database's
historical usage/spending observations. Do not delete that database as a cache reset.

A selected session outside the target shared home offers **Copy and resume** or
**Cancel**. The supported legacy format is staged as a snapshot, then copied through
native `thread/fork` and verified by native resume. Active and archived originals stay
in place. The copy receives a new native ID and provenance under
`<target-home>/.genesis-tools/session-imports/`; repeating the same import reuses it.
Changed sources, malformed partial records, and divergent provenance are rejected.
An uncertain interrupted fork retains a recovery record and blocks duplicate retries.

Paginated history can be searched through its native projection store, but cross-home
copy is currently rejected: the tested native fork path cannot load that separate
store. No native SQLite rows are synthesized, and native databases are never symlinked
between homes. Cross-provider history conversion is outside this command's scope.

## Merging Codex homes (`migrate-home`)

`tools codex migrate-home` folds the transcripts of other Codex homes into one home, so a plain
`codex resume` and the Desktop app see every past conversation in one place. It copies; it never
moves and never unlinks.

```bash
tools codex migrate-home                                   # dry run over every ~/.codex-* sibling
tools codex migrate-home --from ~/.codex-personal --to ~/.codex
tools codex migrate-home --from ~/.codex-personal,~/.codex-work --desktop --apply
tools codex migrate-home --json                            # machine-readable report
```

`--from` takes a repeated flag or a comma-separated list, and defaults to every `~/.codex-*`
sibling holding a `sessions/` directory, minus backups and the destination. `--to` defaults to
`~/.codex`. Without `--apply` nothing is written. In a TTY the command shows the plan and then
asks; without a TTY it needs `--apply`.

Safety rules, all of them load-bearing:

- **A home in use does not block the copy, but a rollout being written does.** The copy only
  adds files no holder touches, so a live `codex` on either home is fine; a rollout a process
  still has open is left for a later run and listed as `LIVE, SKIPPED` with the pids. If `lsof`
  cannot answer, the answer is `unknown` and the run refuses — a home that might be live is
  treated as live. Two operations still refuse outright against a live process, because both
  pull something out from under it: `--archive-source` against a busy source, and `--desktop`
  when the destination's `.codex-global-state.json` is open (close the Desktop first).
- **A `--from` entry it cannot use is skipped, not fatal.** Naming the destination, or a home
  with no `sessions/` directory, is listed under "Skipped sources" and the other sources still
  migrate. The run only refuses when no source is usable at all.
- **It refuses on any native-id collision** rather than picking a winner. A rollout already at
  the same relative path with identical bytes is this command's own earlier run, which is what
  makes a repeat a no-op.
- **The destination is backed up first** by APFS clone into
  `~/.genesis-tools/codex/migrate-home/<stamp>/`, both `sessions/` and
  `.codex-global-state.json`. The source needs no backup because it is never touched.
- **Older backups are packed after each applied run.** The newest two runs stay folders while
  they are at most 14 days old; every other run becomes `<stamp>.zst` (tar inside seekable
  zstd, checked file by file against the folder before the folder is removed). The runs are
  APFS clones of each other, so removing one run while a newer one stays frees almost nothing;
  packing the old ones together is what frees their space. Restore a run with
  `tools compress unpack ~/.genesis-tools/codex/migrate-home/<stamp>.zst`.
- **Every copy is verified** by size and SHA-256 before the run counts it.
- **The date tree is preserved verbatim.** Paths are never re-derived from the rollout header
  timestamp, which differs from the filename timestamp.
- **Thread names come with the transcripts, through both of the places Codex keeps them.** A name
  never lives in the rollout. `session_index.jsonl` is what this repo's history index reads, and
  `threads.name` in the home's `state_*.sqlite` is what the Codex TUI shows — carrying only the
  first still opens the thread unnamed, and then the first thing you type into it becomes the
  thread's new name. Both are carried, for every thread whose rollout the destination now holds,
  an earlier run's copies included. A name the destination already has is never overwritten, so a
  rerun is a no-op and Codex's own rename always wins. Names for rollouts that are not there are
  left behind, and the state databases are backed up beside `sessions/` before anything is written.
- `--archive-source` renames each source `sessions/` to `sessions.migrated-<stamp>` after the
  copy verifies. It is off by default and it still deletes nothing.

🛑 **A copy leaves the same conversation in two homes, and the history index counts both.**
`session_metadata` is keyed `(provider, native_id, source_home)` and `file_daily_stats` by the
per-home source key, so after `tools codex history index sync` a copied rollout contributes its
conversation, its messages and its tokens TWICE to `tools codex history statistics` — once per
home. Verified on the live index: one codex thread present in two homes reported 2 conversations
and 100 messages for a single day. Nothing is lost and nothing crashes; the totals are simply
inflated by the number of rollouts that now exist twice. Prevent it by taking the source home out
of circulation after the copy verifies — `--archive-source` renames its `sessions/`, which is what
stops discovery finding it — or accept the inflation until you do.

`--desktop` also merges `.codex-global-state.json`, which is what makes the sessions appear
under the right projects in the Codex Desktop app. Projects are merged **by normalised root
path, never by id**: the destination already holds one project under a raw UUID beside nine
under `local-<md5>`, so an id-keyed merge would add a second entry for the same directory on
every run. Unseen ids are appended to `project-order`, thread assignments are taken from the
source only for threads the destination lacks and are remapped onto the destination's project
id, and `selected-project` is left alone. The merged file is written atomically.

What it does **not** carry: `auth.json`, `history.jsonl` (the up-arrow recall buffer), the
per-home SQLite databases, and `archived_sessions/` — only `sessions/` is enumerated (both
`rollout-*.jsonl` and the `rollout-*.jsonl.zst` files Codex 0.164 compresses, copied as they are), so a
source home's archived threads stay where they are. ⚠️ `--archive-source` renames `sessions/`
only, and a home without one is no longer discovered, so an un-migrated `archived_sessions/`
becomes invisible to later runs; copy it by hand, or leave that source unarchived.

⚠️ Two per-home SQLite databases matter more than the rest: `thread_history*.sqlite` holds the
body of every `history_mode: paginated` thread. A copied rollout finds no projection in the
destination, and history then reads the rollout itself and reports
`Paginated projection unavailable for native thread`. For a forked thread the rollout replays
its parent's turns, so the first prompt of such a session can read as the parent's. After a run, re-index with `tools codex history index sync`. Note
that the index keys a session on `[provider, source home, native id]`, so a moved rollout is a
new key and `session_metadata.source_home` no longer names the home it came from. The
per-rollout mapping was captured out of band in the notes vault, under
`GenesisTools/AILaunchers/Verify-CodexAccountProvenance.md`.

## Computer Use and JavaScript

When the official Mac runtime and helper are installed in the selected shared home,
`run` automatically supplies process-local Computer Use configuration. It preserves
existing browser service registrations in `node_repl` and adds official `@oai/sky`.
Use `--computer-use` to require the installation, or `--no-computer-use` to skip the
overrides. Desktop regeneration of its configuration file cannot erase overrides
already supplied to that launch. OS permissions and browser connections still apply.

`node_repl` is the persistent JavaScript runtime; `@oai/sky` provides native app
control. The separate `cua_repl` plugin is a unified browser/computer wrapper around
that runtime, exposing `cua` APIs. A successful Sky call does not establish that this
separate wrapper is enabled. The launcher does not patch desktop-managed plugin
manifests or install missing plugins. Worker `spawn` also accepts `--computer-use`.

The desktop account remains separate from CLI account selection. Avoid editing one
native conversation from two processes at once.

Installed-binary protocol tests use synthetic credentials and temporary homes:

```bash
RUN_INTEGRATION=1 bun run test src/codex/lib/terminal-server.test.ts
```

Sources: [app-server protocol](https://learn.chatgpt.com/docs/app-server),
[external-token API declaration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs).

## Managed workers and account commands

```bash
tools codex spawn \
  --name reviewer \
  --mode review \
  --base origin/master \
  --prompt "Review this branch"

tools codex status --name reviewer
tools codex tail --name reviewer --follow
tools codex logs --name reviewer --format compact   # the transcript door every backend shares (json|jsonl|events|raw)
tools codex steer --name reviewer --prompt "Focus on the auth path"
tools codex interrupt --name reviewer
tools codex rollback --name reviewer --turns 1  # revert the persisted history through thread/revert; file changes stay
tools codex read --name reviewer
tools codex review --name reviewer --scope working-tree
tools codex review --name reviewer --base main --scope branch --adversarial auth rollback
tools codex stop --name reviewer
tools codex sessions [--json]                   # every session with its derived status
tools codex who [--json] [--all]                # live codex processes and the account each one bills

tools codex warmup [name...] [--all] [--json]   # one tiny request per account to start its session timer (shared with tools ai warmup)

tools codex login [name]                       # browser login into the shared account vault
tools codex usage [--json] [--range 24h]          # the shared usage dashboard pinned to this provider
```

`spawn`, `steer`, `read`, `tail`, `status`, `sessions`, `stop` and `interrupt` are the shared
worker verbs (`src/ai/commands/agent/worker.ts`); what makes them codex is `codexDriver`
(`src/codex/lib/driver.ts`). `steer` still answers to its older `--body` / `--body-file`
spelling, hidden from help.

### Review mode (`--mode review`)

`--mode review` needs a base: `--base <ref>`, else the branch's PR target, else its upstream (never the branch's own
remote copy); the spawn prints which. It runs `git diff --numstat <base>...HEAD` in the worker's cwd (limited to
`--paths <path...>` when given) and refuses an empty diff. The worker's developer instructions carry the shared worker
contract plus `reviewLines(effort)` from `src/utils/worker/contract.ts` and the manifest (`Files to review (N, +A -D)`
and one line per file). The manifest pins the merge-base and head commits, so a steer or escalation reviews the
same range after either branch moves. Pass `--pr <number>` to record an explicit PR identity in detached reviews.

The tier is `--effort`, else the diff size: `high` up to 15 files and 800 changed lines, `xhigh` above. `max` only when
named. `low` (triage) and `medium` are refused unless `--allow-shallow`. Above 60 files or 4,000 lines the spawn prints
a split suggestion, one reviewer per folder with `--paths`.

After each review turn the daemon runs the depth gate (`src/codex/lib/review/gate.ts`): the `Files reviewed: n of N`
line against the manifest (a binary file named with a reason is excused), reasoning tokens per 100 changed lines
against the tier floor (high 100, xhigh and max 250), and the finding shape (`N. [Severity] path:line - defect.
Scenario: ... Fix: ...`, then `Ran:`). The first miss steers the same session once with the unread files; the second
starts `<chain>-<next tier>` as a new session (a steer cannot change a thread's effort), at step 2; a miss after that,
or a miss at `max`, ends the review `shallow`. A medium review with `--allow-shallow` is never tuned up. Each decision
also goes to the agents bus as a `review_gate` event.

Every review start, review turn and gate decision is one line of `~/.genesis-tools/codex/reviews.jsonl`:

```bash
tools codex reviews [--since 24h] [--pr <n>] [--label <text>] [--effort <tier>] [--verdict pass|steered|escalated|shallow|open] [--name <text>] [--json]
tools codex review-depth <name> [--json]        # one review: manifest, spend, coverage, reasoning per 100 lines, verdict, gate history
tools codex review-depth <name> --base <ref>    # the same checks for a session spawned without --mode review
tools codex reviews import <name...> [--base <ref>] [--no-cwd-from-session] [--json]
```

`reviews import` backfills sessions that ran before the ledger: a start line, one turn line per booked turn of the
worker cost ledger, and a gate line marked `imported: true`. Its verdict comes from the final agent message (from the
session's event log): `pass` for `Files reviewed: n of n`, `shallow` for fewer, `imported` with no such line. The
manifest uses the session's saved pinned commits when available, even if its cwd is gone. For older sessions it
reconstructs both HEAD and the chosen base from their reflogs at the session's start time, then diffs their
merge-base to that historical head. Missing reflogs, an unknown base or a removed cwd leave counts null and scope
unconfirmed. Commit dates alone cannot establish when a ref moved. Named binary files with a reason get the same
coverage exemption as live reviews.
A session already in the ledger is skipped, so a repeated import adds nothing.

`login` and `usage` are doors onto the provider-neutral account core: the same code runs behind `tools ai accounts login --provider codex` and `tools ai usage --provider codex`. `tools ai accounts discover --provider codex` lists every `~/.codex*` profile on the machine and `--bind` turns the unbound ones into accounts.

Sessions are read-only by default. For implementation work, use `--write ask` for supervised approvals or
`--write allow` for a trusted bounded worker that does not commit. `--write deny` is explicitly read-only.
`--write full` runs with no sandbox (`danger-full-access`, approval policy `never`) and is refused when the cwd is in a
main checkout (a `.git` folder at or above it): use it only in a throwaway linked worktree or a non-git scratch folder.

In the workspace-write sandbox of `ask` and `allow` a worker cannot write any path inside a `.git` folder, so it cannot
commit (under `ask` an approved commit runs outside the sandbox). It cannot exec setuid binaries such as `/bin/ps`, so
the `@genesiscz/utils/process/ps` readers that spawn `ps` return nothing. It has no network, so a `bun install` that
downloads fails. `spawn` prints the limits of the chosen policy as warnings and returns them as `warnings` in its
JSON result. The measurements and the way around each: `plugins/genesis-tools/skills/handoff-to/references/codex.md`,
section "What a sandboxed worker cannot do".

With `--write ask`, Codex uses its `untrusted` approval policy: commands outside Codex's built-in trusted read-only
set, sandbox escalations, and file-change approval requests pause and are forwarded to `lead` as `approval_request`
messages. Resolve one with `tools codex approve --name <n> --request <id>` or `deny`. Codex 0.162.1 has no protocol
mode that pauses its built-in trusted read-only commands; `untrusted` is its strictest supported command policy.
The one exception the daemon accepts itself is the worker's own seeded bus command (`tools agents message`, `login`,
`request` or `leave` as `codex_<name>` with its own `--session`, from its own thread, holding no shell operator,
redirection or expansion), recorded in the event log as `approval/auto-accepted`. Without it every `ask` worker's
first action, its "received; starting" report, waited for the lead.

The daemon also accepts a command that only reads (`isReadOnlyCommand` in `lib/bus-approval.ts`): every segment of
the script is `cat`, `head`, `tail`, `wc`, `nl`, `ls`, `pwd`, `stat`, `cd`, `grep`, `rg` (not `--pre`), `find`
(not `-exec` or `-delete`), `sed -n '<a>,<b>p'`, or a read-only `git` subcommand (no `-c`, no `--output`), with no
redirection, expansion or background job. Codex's own read-only set does not parse a `zsh -lc` script, so before
this an `ask` worker sent every `cat` and `sed -n` to the lead (44 approvals in one 9-minute turn, 2026-10-14). A
file-change approval names the files it writes (`edit src/a.ts, README.md`); the request itself carries only an
item id.

The driver joins the parent Claude Code swarm through `tools agents`. Use `--no-agents` to disable that integration,
or `--session <id>` when the parent session cannot be discovered from `CLAUDE_CODE_SESSION_ID`.

A spawned worker's thread gets an app-server `projectId` once its first message is recorded: the project named by
`--project <id|name|root>`, otherwise the project whose root holds the cwd (a linked worktree falls back to its main
checkout). An unknown or ambiguous `--project` fails the spawn; `tools codex status` shows the result as
`desktopProject`.

⚠️ That id does not decide where Codex Desktop (26.930) shows the thread. Read from its bundle on 2026-10-13:

- Its sidebar lists its own thread index, which only Desktop's own app-server events, a window load or a reconnect
  refresh. A worker runs its own app-server, so its thread appears after Desktop next re-reads the list (reload the
  window, or restart Desktop).
- It places a thread by cwd (a project root, or a folder below one) and by assignments it wrote itself. A root that
  two projects list belongs to one of them: a single-root project first, then the project that lists it first. Desktop
  reads the app-server `projectId` only behind its `localProjectTaskMembership` flag, which was off.

To land a worker under a project in Desktop today, start it in a folder that project owns by those rules.

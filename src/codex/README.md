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
`luna` → `gpt-5.6-luna`, `sol` → `gpt-5.6-sol`. Full IDs and shared config model
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
- **Every copy is verified** by size and SHA-256 before the run counts it.
- **The date tree is preserved verbatim.** Paths are never re-derived from the rollout header
  timestamp, which differs from the filename timestamp.
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
per-home SQLite databases, and `archived_sessions/` — only `sessions/` is enumerated, so a
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
  --prompt "Review the current working tree"

tools codex status --name reviewer
tools codex tail --name reviewer --follow
tools codex logs --name reviewer --format compact   # the transcript door every backend shares (json|jsonl|events|raw)
tools codex steer --name reviewer --body "Focus on the auth path"
tools codex interrupt --name reviewer
tools codex read --name reviewer
tools codex review --name reviewer --scope working-tree
tools codex review --name reviewer --base main --scope branch --adversarial auth rollback
tools codex stop --name reviewer

tools codex warmup [name...] [--all] [--json]   # one tiny request per account to start its session timer (shared with tools ai warmup)

tools codex login [name]                       # browser login into the shared account vault
tools codex usage [--json] [--range 24h]          # the shared usage dashboard pinned to this provider
```

`login` and `usage` are doors onto the provider-neutral account core: the same code runs behind `tools ai accounts login --provider codex` and `tools ai usage --provider codex`. `tools ai accounts discover --provider codex` lists every `~/.codex*` profile on the machine and `--bind` turns the unbound ones into accounts.

Sessions are read-only by default. For implementation work, use `--write ask` for supervised approvals or
`--write allow` for a trusted bounded worker. `--write deny` is explicitly read-only.

With `--write ask`, Codex uses its `untrusted` approval policy: commands outside Codex's built-in trusted read-only
set, sandbox escalations, and file-change approval requests pause and are forwarded to `lead` as `approval_request`
messages. Resolve one with `tools codex approve --name <n> --request <id>` or `deny`. Codex 0.144.5 has no protocol
mode that pauses its built-in trusted read-only commands; `untrusted` is its strictest supported command policy.

The driver joins the parent Claude Code swarm through `tools agents`. Use `--no-agents` to disable that integration,
or `--session <id>` when the parent session cannot be discovered from `CLAUDE_CODE_SESSION_ID`.

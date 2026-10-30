# Claude Tool (`tools claude`)

Claude-focused utilities for local Claude Code workflows:

- Search and summarize conversation history
- Resume past sessions
- Sync skills to Claude Desktop
- Inspect Claude usage/quota
- Manage Claude auth/config
- Migrate Claude assets to Codex (`migrate-to codex`)
- Reopen a set of sessions as cmux workspaces (`cmux`)
- Run Claude Code on a non-Anthropic model through ai-proxy (`proxy`)

---

## Quick Start

```bash
# General help
tools claude --help

# History search
tools claude history "mcp manager"

# Resume session
tools claude resume

# Claude usage
tools claude usage

# Start the session timer on accounts with one tiny request (same command as tools ai warmup)
tools claude warmup --all

# Migrate Claude assets to Codex (interactive wizard)
tools claude migrate-to codex

# Reopen recent sessions as cmux panes
tools claude cmux

# Anthropic start inside tmux (alias: run). On --resume <query>, the tmux
# session is named from the conversation title. A bound ttyd is renamed too.
tools claude start work --tmux --resume "auth callback"
```

`--tmux` applies to `tools claude start` / `run` for Anthropic accounts. A slash target (`account/provider`) still goes to `proxy` and ignores `--tmux`. If you are already inside tmux, this renames the current session instead of nesting a new one.

### Apps that embed Claude Code (T3 Code, the Agent SDK)

Such an app asks for the path of a `claude` binary and spawns it with stream-json arguments. Give it
a wrapper script that holds no token, with the absolute path of `tools` (the app's PATH may not have it):

```sh
#!/bin/zsh
exec /path/to/GenesisTools/tools claude run --autopick --sdk -- "$@"
```

`--sdk` runs the real executable with no interactive shell between. A shell function such as `ccc`
adds `--dangerously-skip-permissions`, which would override the permission mode the app chose. It
also passes the app's stop signals on to claude, so a stopped session does not keep running.
`--autopick` picks the account with the most headroom on every spawn; give an account name to pin one.

---

## Shared native history index

Searches/listings automatically build the index on first use and synchronize changed sources. No manual indexing command is required. Explicit sync/rebuild are optional maintenance; status is read-only. Indexing never imports credentials or migrates source conversations.

Claude history and query-based resume use the provider-native history index shared
with Codex and Grok. Existing Claude filters, result rendering and picker behavior
remain available; the legacy web and spending/statistics APIs keep their interfaces.
Searches stay scoped to Claude and the current project unless `--all` is supplied.

```bash
tools claude history "callback" --file src/auth.ts --context 2
tools claude history "callback" --all --sort-relevance --exclude-thinking
tools claude history index status
tools claude history index sync
tools claude history index rebuild
```

History extends the existing `~/.genesis-tools/claude-history/index.db` with provider
identity and bounded metadata. Searches read matching text and context from native
records; full statistics refresh replaces aggregate contributions independently.
History rebuild preserves native sources, credentials and the database's historical
usage/spending observations. Never delete the whole database as a cache reset.
A non-interactive resume query with several matches fails instead of silently
choosing the first session.

## `proxy` — Claude Code on a proxied model

Launches Claude Code against a model served by `tools ai-proxy` (Grok, GitHub Copilot,
OpenRouter, xAI) instead of api.anthropic.com. The proxy answers the Anthropic Messages API
natively; see `src/ai-proxy/README.md` for the translation.

```bash
tools claude proxy martin/grok -m 4.5        # <account>/<provider> plus a model filter
tools claude proxy work/xai/grok-4.6         # or a full proxy model id
tools claude run martin/grok -m 4.5          # `run` routes here when the name has a slash
tools claude proxy martin/grok --list        # list matching models, launch nothing
tools claude proxy martin/grok -- -c         # args after -- go to claude
```

`[target]` is an `<account>/<provider>` prefix or a full proxy id; `-m/--model` filters inside it
(every whitespace-separated token must appear, so `-m "composer fast"` works). Several matches
open a picker in a TTY and fail with the list otherwise.

A **full id on a known account launches even when the catalog does not list it**, with a warning.
The proxy advertises a curated list but routes any id whose account exists, so
`martin/grok/grok-4.6` answered chat while `ai-proxy models` still hid it. A typo in the account
or provider segment still fails locally rather than becoming an upstream 404.

The proxy is started if it is not already answering; `--no-start` turns that into an error
instead. The launch clears `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from the child
environment — either one would outrank the proxy token and silently bill the real Anthropic
account.

`tools claude start` (alias `run`) is unchanged for Anthropic accounts. The split is the slash: no
Anthropic account name has one, every ai-proxy target does. `-e/--effort` works on both: Claude
Code's own `--effort` for an account, the `:<effort>` suffix for a proxy target.

## `codex`: Claude Code with its main loop on a Codex model

```bash
tools claude codex                            # auto Codex login, auto Claude login, sol at high
tools claude codex cdx-work -m astra -e xhigh # a named Codex login, another model and effort
tools claude codex --claude none              # no Claude account: Claude models are refused
tools claude codex --grok auto                # grok/<model> ids work in the session too
tools claude codex --resume "the parser bug"  # resume: same session id, same subagents, a fresh key
tools claude codex -- -p "one turn"           # args after -- go to claude
```

The main loop runs on `codex/<model>` through ai-proxy; titles and the Claude-side calls run on
the Claude account; one subagent per Codex model (`sol`, `sol-xhigh`, `sol6`, `astra`, `terra`, `luna`),
`opus` (and `fable` when the Claude account has it) on the Claude account, and `codex-worker`,
which hands a task to `tools codex spawn`. Each launch writes a session record
(`~/.genesis-tools/ai-proxy/sessions/<Claude Code session id>.json`) and gives Claude Code its
own `gts_` key; the proxy then routes `codex/<id>`, `grok/<id>` and bare `claude-*` ids to that
session's accounts only.

- **Accounts.** `[account]`, `--claude` and `--grok` take a login (a `tools codex` / `tools claude`
  / `tools grok` account) or a configured ai-proxy account; a login gets an account the proxy
  builds in memory, nothing is written to the proxy config. A configured account named on the
  command line keeps its own settings, so the legacy Codex account that reads `~/.codex/auth.json`
  still works. `auto` (the default) ranks the logins by usage and prints the runner-up.
- **Billed accounts.** Subscriptions only by default. An account billed per token needs
  `--allow-metered <account>` or a yes at a prompt (no default yes); a non-interactive launch
  without the flag stops before anything starts.
- **Errors, not failover.** The session never moves to another account by itself. A usage limit,
  a dead login or a rate limit shows in Claude Code with the account, the reset time and the
  command that switches: `tools ai-proxy session <id> use --codex <account>` (also `--claude`,
  `--grok`; without a flag it lists the accounts). The next turn runs on the new account, with
  no restart; the status line keeps the launch's names.
- **`/model` stays in the session.** Claude Code saves a `/model` pick into the shared `~/.claude/settings.json`,
  where every other session would read `codex/…` as its default and fail. While the session runs, the launcher puts
  the file's launch-time `model` back whenever a `codex/` or `grok/` id lands there; the session keeps its pick.
- **Window.** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and the compact window are the model's usable
  tokens from the Codex catalog, passed in `--settings` too, because the `env` of
  `~/.claude/settings.json` would otherwise win. `-c <percent>` changes the compact percent. The `/model` picker
  lists only models whose usable window covers this limit; launch a fresh session to use a smaller model. A custom
  `--settings` after `--` can change the limit, so picker entries are disabled when the limit is unknown.
- **`--isolated`** uses its own Claude Code config folder under
  `~/.genesis-tools/claude-codex/config/<session id>/` and writes the subagents there as files.
- **`--port`** aims at another ai-proxy (a second one for tests); it is never started for you.

---

## `cmux` — reopen sessions as workspaces

Pick recent Claude Code sessions and rebuild them as cmux panes, each one resuming under the
account it originally ran as. Built for the machine-died case, and for pulling a set of
threads back up on purpose.

```bash
tools claude cmux                       # pick from the 12 most recently ACTIVE sessions, any project
tools claude cmux --last 30             # reach further back
tools claude cmux --this-project        # only this directory's project
tools claude cmux --dry-run             # print the plan, touch nothing
tools claude cmux snapshot before-reboot
tools claude cmux restore before-reboot
tools claude cmux list                  # saved snapshots
tools claude cmux tree                  # live window → workspace → pane → surface map, with session ids
tools claude cmux open-session <id> --workspace workspace:1   # resume as a new pane there
tools claude cmux send <id> "run the tests"   # type into the session's own pane
tools claude cmux send <id> "/compact" --no-enter --dry-run
tools claude cmux send <id> --option b       # answer the open AskUserQuestion by its option key
tools claude cmux read <id> --lines 40       # print that pane's text
tools claude cmux find <id> --decision 7     # transcript view (ctrl+o) scrolled to DECISION 7, tab raised after a hit
tools claude wait <id|title> [--timeout S] [--next] [--stream] [--json]   # block until the turn ends
tools claude message <id|name|title> "status?"   # into the running session's socket, no typing
```

`tree` (`--json` for machines) enumerates every cmux window and annotates each surface with
the Claude Code session it hosts, from the refs journal plus the `· 8hex` tab-title marker.
`open-session` resumes one session at a chosen level: `--window` makes a new workspace,
`--workspace` a new pane, `--workspace --pane` a new tab, `--workspace --surface` types the
resume command into that surface (`--no-enter` queues it). The command comes from the same
builder restore uses, so the pinned account and auth mode survive.

`wait` reads the session's transcript, never the pane, and exits when the current turn ends. The shared
file watcher (`watchFileFeed`) wakes it on every write; a 5 s poll only notices silence and the deadline. A
question the agent asks while it keeps working is listed in `questions` (and on stderr) and does not end
the wait. Exit codes: 0 when the
session is back at its prompt (the final assistant message goes to stdout, a status line to stderr),
3 when a running turn has written nothing for `--stall-timeout` seconds (default 900, `0` never),
124 on `--timeout`, 1 when no session matches. An idle session returns at once; `--next` waits for the
next turn instead. `--last <n>` prints the last N assistant messages (separated by `---`), `--tools` adds
the tool calls of the turn that ended (`tools: Bash ×2, Edit ×1`), `--quiet` prints only the status line. `--json` prints `{outcome, state, sessionId, lastText, asksQuestion, durationMs, ...}`;
`asksQuestion` is true when the session waits on its question tool: Claude `AskUserQuestion`, Codex
`request_user_input` (unanswered) or a turn that ended on `request_user_input_async`, Grok `ask_user_question` or
`exit_plan` (no result yet). It is decided from the tool calls, never from the wording; the old `?`/`❓` wording
check is kept behind `DECISION_HEURISTICS` (off) in `turn-wait.ts`. The same verb exists as
`tools grok wait` and `tools codex wait`. `<session>` is an id (8+ characters), a transcript path or a
`/rename` title (Grok: the session summary; Codex: the thread name).

`tools claude message <session> "<text>"` (also `tools codex|grok message`) sends into a RUNNING session
through the agent's own channel, never by typing into its pane. Claude: the session's cross-session socket
(`~/.claude/sessions/<pid>.json` names `/tmp/cc-socks/<pid>.sock`); a busy session reads it between tool
calls, an idle one starts a turn. Sent from inside a Claude Code session, the message carries the
`cross-session-message` envelope that names that session and its permission mode (bypass or prompting), as
Claude's own SendMessage does; the receiver delivers it at once when that mode matches its own and holds it
for approval when they differ. A send from outside Claude Code names no mode, so a session in bypass mode
holds it. A session that GenesisTools starts (`tools claude run`, and `tools cmux agents new claude` through it)
accepts everything by default: it passes `--settings {"crossSessionInbound":"accept"}`. The default is the
`launch.crossSessionInbound` key of `~/.genesis-tools/claude/config.json` (`accept` or `hold`, default `accept`);
`tools claude config cross-messages` prints it and where it comes from, and `tools claude config cross-messages hold`
saves another value. `hold` passes nothing, so Claude Code's own settings decide. Per run, `--cross-messages` or
`--no-cross-messages` wins over the key, and a `--settings` of your own after `--` turns the default off (Claude Code
takes one `--settings`). Sessions started by hand keep Claude Code's own setting. `--wait` waits for the end of the turn the message starts and prints one delivery
line on stderr right after the send. `<session>` is a session id or
8+ character prefix, the session name, or a `/rename` title; several matches fail with each candidate's
exact command; part of the cmux tab or workspace title also works (`vybava` finds "vybava - grok"). Codex:
`codex queue` on the shared app-server (a TUI started against it). Grok: no structured channel (the TUI
listens on no socket). Where there is no channel, `--allow-keystrokes` pastes into the session's cmux tab
with `cmux paste --submit`, which refuses over a draft or an open dialog. `--priority now|next|later`
(Claude), `-` reads stdin. `--wait` then waits for the turn that answers and prints the reply, with the
exit codes of `wait`; `--wait-timeout`, `--stall-timeout`, `--stream`, `--last`, `--tools` and `--quiet`
work as there, and `--json` prints the wait report with a `delivery` field. A reply that already ended
before the wait began still counts, because the send time is the baseline.

`send` types text into the pane a session already occupies, resolving `<id>` in stages:
the refs journal first, then an exact id, an id prefix, the tab title, the workspace, and
finally the working directory. A weak match with more than one candidate is refused rather
than guessed at, because typing into the wrong agent session is worse than not typing;
`--first` overrides that for the non-weak cases. `--no-enter` leaves the text in the prompt
without submitting it, and `--dry-run` prints the pane it would type into and stops.
Multi-line text always goes as one `cmux paste --submit` (typed keystrokes turned every newline
into its own prompt); `--paste` asks for the paste for a single line too.

`send` refuses to type while the session shows a question, plan or permission dialog, because
the text plus Enter would pick an option the user never chose (a live paste into an open
`AskUserQuestion` picked its first option, 2026-10-30) or land in the dialog's text field. It
asks state signals only, never the screen: the dialog records the hooks write
(`~/.genesis-tools/agents/dialogs/<provider>/<session>.json`), then the transcript's turn state,
then Claude Code's own registry entry (`status: "waiting"`), which is the one signal that sees
an open `AskUserQuestion`: the transcript gets that tool call only after it is answered. A
refusal exits 1; `--json` prints `{ sent: false, reason, dialog }`. `--force` types anyway and
passes `--force` to `cmux paste`.

`send <id> --option <letter>` answers the session's open question dialog by key presses, never
by text. It reads the newest open dialog record of the session (only a record carries the
options), maps the letter (or a 1-based position) to the option, presses its key, and closes the
record. It refuses, with nothing pressed, when no record is open, when the record has no options
(a plan or permission prompt), when it asks several questions, when the letter is past the list,
or when the harness has no measured keys. The keys per harness are `DIALOG_KEY_MAPS` in
`src/utils/agents/dialogs/keys.ts`. Claude's are measured (2.1.314, 2026-10-30): the option's digit,
typed with `cmux send --force`, picks and submits it wherever the highlight is. Codex and Grok are
"unknown" there, so their dialogs refuse. An inbox item from a dialog record (`source: "dialog"`)
is answered through this path: `tools question inbox answer --dialog <provider:session:toolCallId>
--option <letter>`, or the widget action `dialog-answer`, which the widget setting `dialogAnswer`
(`press` by default, or `refuse`) governs.

A decision answer from the inbox (`tools question decisions send`, the hub) is delivered by
`deliverToSession` (`src/question/lib/decisions/deliver.ts`) down a ladder of rungs, and the
result names the rung in `channel`:

1. `codex`: a Codex thread that a live `tools codex` worker runs is steered through the
   app-server (`codex steer`, with an input receipt).
2. `resume`: a Claude or Grok session that GenesisTools owns as a worker gets a resumed turn
   (`claude worker steer`, `grok steer`), acknowledged by a completed same-session turn.
3. `claude-peer`: a live interactive Claude session gets the message on its cross-session socket. A session that
   GenesisTools started accepts it at once by default (`launch.crossSessionInbound`, see `tools claude message`);
   another session in bypass mode may hold it for approval.
4. `grok-leader`: an interactive Grok TUI that runs inside a shared Grok leader (`tools cmux agents new grok`
   starts it as `tools grok run --leader-socket <sock> --session-id <uuid>` and records both under the session
   record's `providers.grok.leader`) gets the answer as an ACP `session/prompt`, sent by a second client
   (`grok agent --leader --leader-socket <sock> stdio`, `GrokAcpClient` in `src/utils/ai/grok/acp.ts`). The
   socket comes from the record, else the default `~/.grok/leader.sock`; the session is matched by id through
   `session/list`. Delivered means the leader queued the prompt (`_x.ai/queue/changed`); the turn then runs in the
   leader and the TUI shows the prompt and the answer. No socket, no listed session, or a refusal falls through to
   the pane; a prompt with no acknowledgement is an unknown outcome and is not typed again. `tools grok cmux send`
   tries the same rung first (`structuredSend` in `src/grok/lib/spec.ts`), except with `--dry-run` or `--no-enter`.
5. `cmux`: the last rung types into the session's pane with `tools claude cmux send --paste
   --exact-session`, after the dialog guard said no dialog is open.
6. `queued`: no rung took it, or the guard refused; with a source home and a delivery key the
   message is saved for this exact session with the reason.

Only the `cmux` rung types, so only it is guarded; the other rungs are structural and a dialog
cannot swallow them. The delivered text opens with one line that says it is the user's own answer
relayed from the decision inbox (`RELAYED_ANSWER_HEAD` in `delivery-text.ts`), then
`DECISION <n>: <letter>) <the user's words>` per answer.

Each pane runs `cd <session cwd> && tools claude start <account> -- --resume <id>`. The
`--resume` sits after `--` so claude gets the id verbatim; before it, `tools claude start`
would treat the id as a search query and prompt.

### Layout

Sessions group into one workspace per project (`--no-per-project` to merge them), and each
workspace holds an even grid:

| Flag | Effect |
|---|---|
| `--layout capped` (default) | Grid capped at `--per-workspace` panes (4); the rest spill into `project 2`, `project 3` |
| `--layout grid` | One workspace, every session a pane — cmux clamps at its minimum pane size past ~8 |
| `--layout tabs` | Fill the cap in panes, then stack the overflow as extra tabs inside them |

Other flags: `--account <name>` forces one account on every pane, `-a` auto-picks for panes
with no recorded account, `--no-enter` queues each command at the prompt instead of running
it, `--new-window` builds in a fresh cmux window, `-y` skips the picker.

### The account pin

Nothing in Claude Code's transcripts records which account a session ran as, so it is
recorded at session start by `hooks/record-session-account.ts` in the **genesis-tools
plugin** — no settings.json editing, it ships with the plugin's other SessionStart hooks.

The hook reads `TOOLS_CLAUDE_ACCOUNT` and `TOOLS_CLAUDE_AUTH` (exported by
`tools claude start`). Auth is `token` (long-lived `CLAUDE_CODE_OAUTH_TOKEN`) or
`keychain` (`--keychain` injects that account's secondary login into the macOS
keychain for the session). Do not infer keychain from a missing OAuth env: Claude
Code strips that secret from hook children. `--resume` after `--` still goes to
claude verbatim. Pre-fix pins that claimed `auth: keychain` without a trusted
source resume on the token path.

```bash
tools claude cmux pins           # what has been recorded, newest first
```

Only sessions started after the hook landed have pins. Sessions without one show as
`unpinned` and ask which account to use when their pane launches (or take `--account` /
`-a`). Plugin edits need a push plus `/plugin update` before Claude Code picks them up.

---

## `migrate-to codex`

Interactive migration wizard for moving/syncing Claude assets into Codex-compatible locations.

### What it discovers

- **Skills**
  - Project: `./.claude/skills/*/SKILL.md`
  - Project plugins: `.claude-plugin/marketplace.json` + `plugins/*/.claude-plugin/plugin.json`
  - Global: `~/.claude/skills/*/SKILL.md`
- **Commands**
  - Project: `./.claude/commands/**/*.md`
  - Plugin command markdown folders from plugin manifests
  - Global: `~/.claude/commands/**/*.md`
- **Instructions**
  - Project and global `CLAUDE.md`

### Target mapping

- **Skills** -> Codex skills folders:
  - Project: `./.agents/skills/`
  - Global: `~/.codex/skills/`
- **Commands** -> Codex prompt files:
  - Project: `./.codex/prompts/`
  - Global: `~/.codex/prompts/`
- **Instructions** (`CLAUDE.md`) -> `AGENTS.md`
  - Project scope: `./AGENTS.md`
  - Global scope: `~/.codex/AGENTS.md`

### Wizard behavior

- `ESC` goes back one step (instead of cancelling immediately)
- Existing-target conflicts are resolved interactively:
  - show diff (`src/utils/diff.ts` helper)
  - overwrite
  - skip
  - rename target path
- Steps:
  1. Choose source scope (`project`, `global`, `both`)
  2. Choose components (`skills`, `commands`, `instructions`)
  3. Choose target scope (`project`, `global`, `both`)
  4. Choose transfer mode (`symlink` or `copy`)
  5. Choose naming strategy (`prefixed` or `preserve`)
  6. Confirm plan

### Modes

- **symlink** (recommended): always-in-sync
- **copy**: one-time snapshot

### CLI options

```bash
tools claude migrate-to codex [options]
```

| Option | Description |
| --- | --- |
| `--source <scope>` | Source scope: `project`, `global`, `both` |
| `--target <scope>` | Target scope: `project`, `global`, `both` |
| `--components <list>` | Comma list: `skills,commands,instructions` |
| `--mode <mode>` | `symlink` or `copy` |
| `--name-style <style>` | `prefixed` or `preserve` |
| `--force` | Overwrite existing destination entries |
| `--dry-run` | Show planned actions without writing |
| `--list` | Print discovered assets and exit |
| `-y, --yes` | Skip final confirmation |
| `--non-interactive` | Skip wizard and run from flags |

### Examples

```bash
# Guided migration
tools claude migrate-to codex

# See what would be migrated
tools claude migrate-to codex --list

# Global sync via symlinks (non-interactive)
tools claude migrate-to codex \
  --source global \
  --target global \
  --components skills,commands \
  --mode symlink \
  --non-interactive \
  -y

# Instructions only, preview
tools claude migrate-to codex \
  --source project \
  --target project \
  --components instructions \
  --mode copy \
  --dry-run \
  --non-interactive
```

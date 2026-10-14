# `tools agents` — cross-agent communication

CLI for **bi-directional messaging across a swarm of LLM agents** (main agent ↔ subagent ↔ subagent), via a per-session append-only feed at `~/.genesis-tools/agents/<session-id>/feed.jsonl`. No daemon, no MCP server, no network. Built on the GenesisTools storage primitives.

For the *protocol-level* documentation aimed at the agents themselves (when to call which command, mode choices, etc.), see [`plugins/genesis-tools/skills/agents-talk/SKILL.md`](../../plugins/genesis-tools/skills/agents-talk/SKILL.md) (`genesis-tools:agents-talk`).

The design background and research live in the tool's design notes, which are not published. That
directory is gitignored, so the file is local to the machine it was written on and is not part of
a clone. The design decisions it records that still matter are summarised under
[Why a CLI, not an MCP server?](#why-a-cli-not-an-mcp-server) below.

## Commands

```bash
tools agents login --agent-name lead --agent-main              # auto-registers + attaches, stream mode
tools agents login --agent-name researcher                     # auto-registers + attaches (stream mode)
tools agents login --agent-id agt_xxx --agent-name X            # attach with a chosen id
tools agents login --agent-name X --once                       # drain queued batch, or block for mail
tools agents login --agent-name X --once --timeout 300         # same, but give up after 300 s: {"type":"timeout"}, exit 124
tools agents login --agent-name X --format json                # JSON lines only (piped default is monitor, below)
tools agents leave --agent-name X --note "done"                # announce leaving: every other agent gets agent_left
tools agents login --agent-name lead --kinds message,error     # receiver-side verbosity filter
tools agents login --agent-name lead --hide-worker-steps       # drop a Codex worker's per-step "item" events (each finished command, reply, file change); keep its mail, approvals, turn events
tools agents login --agent-name lead --exclude-kinds item,turn_started   # the general form: never emit these feed types or op/event kinds
tools agents login --agent-name lead --filter '.op=="approval_request"'
tools agents message --from X --to Y --body '...'
tools agents message --from X --body '...'                     # broadcast (no --to)
tools agents message --from X --reply 0001 --body '...'        # reply (auto-routes to original sender)
tools agents message --from X --reply 0001                     # pure ack (no body)
tools agents request --from X --to Y --body 'approve?'         # block for correlated reply
tools agents discover                                          # list registry
tools agents listen                                            # human-facing color follower
```

There is no separate `register` command — `login` auto-registers on first use for a given `--agent-name`/`--agent-id`. There is no separate `respond` command — replies go through `message --reply <msg-id>`. `request` is a thin send-and-wait primitive over those same replies; it does not introduce a second channel.

**Joining.** `{"type":"agent_joined","agent_name":…,"present":[…]}` reaches every other agent when an agent comes onto
the bus (its first login, or its first after leaving). A `--once` receiver's later cycles are not joins, so the
channel costs one event at each end and nothing per message.

**Leaving.** `{"type":"agent_left","agent_name":…,"reason":…,"remaining":[…]}` reaches every other agent (it wakes a
`--once` receiver) when an agent runs `leave`, when a stream login ends, when any login is killed by a signal, when a
`--once --timeout` receiver expires with no mail, and when a dead login is reaped. A `--once` cycle that ends on mail is
not leaving. `remaining` names the agents that logged in and have not left since. Joins and leaves pass any `--kinds`
filter, and an agent never receives presence from before it registered.

## Session resolution

Resolves in order:

1. `--session <id>` explicit
2. `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION` (set by `tools codex spawn` / `tools grok run` — the parent saying which swarm to join)
3. The host session id: `$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`, `$GROK_SESSION_ID`, `$COPILOT_AGENT_SESSION_ID`. When several are set (a worker inherits its parent's), the one whose swarm ALREADY EXISTS wins, so a worker joins its parent instead of starting an orphan swarm. If none exists, the first present id creates one.
4. Single session active (feed touched) in the last 60 seconds
5. Otherwise: a friendly error asking for `--session` or one of those env vars

The **main** agent's login stream is the swarm inbox: it receives every `message` except its own sends, so a parent `monitor` on `tools agents login --agent-main` sees peer-to-peer hops. Non-main agents still only see mail addressed to them (plus broadcasts).

`login` prints one stdout-only `{type:"ready",...}` event as soon as the slot is attached (not written to the feed). After that, stdout is feed events only. When stderr is not a TTY (piped into a harness monitor), login stays silent on stderr so diagnostics cannot be mistaken for events.

**Output formats** (`--format`, also on `listen`):

- `monitor`, the default when stdout is not a terminal: each event is a one-line headline, then the event's JSON line, the same text `json` prints. Claude Code draws the first line of a Monitor event as its row, so the row reads `Monitor event: message: reviewer → lead: Review done. ⏎ Two findings: …` instead of a cut-off JSON object, and the model still gets the JSON. The headline never starts with `{`, repeats at most 200 characters of a body on one line, and names agents by name (unique per session). Events written together start with `[i/N]`, because the row shows only the first headline.
- `json`: one JSON object per line. Use it when a program parses every line.
- `pretty`: colored text for a terminal (the `listen` default, and `login --observer` in a terminal). A plain `login` in a terminal prints `json`.

## Codex and hosts without a monitor

Check the tools exposed to each agent. Prefer native collaboration for Codex agents that can all use it. Use this bus for cross-host workers, agents without native peer messaging, shared feed history, broadcast, and correlated replies. A parent having a tool does not prove that every child has it.

With a real monitor, subscribe to `login` stdout directly. Without one, an active agent awaits `login --once` or resumes that command's existing terminal execution handle. A terminal handle does not subscribe the model to future stdout. `--once` drains all queued matching events; with no match it blocks for up to eight hours. Never start a second receiver for the same identity.

In Codex tool sets exposing `collaboration.send_message` and `followup_task`, the first sends to an agent without starting an idle turn; the second starts an idle turn. `wait_agent` waits for native events, not CLI stdout. See the skill for host-specific wake and receiver rules.

For nonblocking communication between working Codex agents, send the full payload with the native tool and continue useful work. Incoming native messages are injected at message boundaries; receiving needs no login, polling, or wait call. Use `followup_task` with the payload when the recipient may be idle. If a child lacks native peer tools and there is no real monitor, a blocking `--once` receiver does not meet a nonblocking requirement.

## Delivery and latency limits

The login cursor advances after writing stdout and also advances past filtered events. It does not acknowledge model consumption or completed work. A reconnect can skip output the harness dropped, or duplicate an emission interrupted before its cursor write. Send an explicit reply after processing when that confirmation matters.

Login and listen schedule filesystem notifications without an intentional debounce delay. Fallback checks remain every 150 ms for login and 1000 ms for listen. CLI startup, full-feed parsing, scheduling, and model turns add latency. A running receiver cannot wake an idle model by itself.

## Key files (per session)

```
~/.genesis-tools/agents/<session>/
  feed.jsonl          ← append-only event log, monotonic seq — the single source of truth
  session-meta.json   ← {debug} session-wide flags
  slots/<id>.login    ← live login PID lock (one per attached agent)
  slots/<id>.cursor   ← per-agent delivery cursor {seq} — also the only dedup mechanism
```

The registry (who's registered, logged in/out) is derived by replaying `feed.jsonl` on every read — there is no persisted `registry.json` or counters file.

## Reused utilities

- `@genesiscz/utils/storage` (`withFileLock`, atomic writes)
- `@genesiscz/utils/storage/storage` (`atomicWriteFileSync`)
- `@genesiscz/utils/storage/stale-lock-sweep` (new — generic stale-PID lock reaper)
- `@genesiscz/utils/log-session/jsonl-reader` (line-safe JSONL parsing)
- `@genesiscz/utils/json` (`SafeJSON`, never `JSON`)
- `@genesiscz/utils/process-alive` (`isProcessAlive`)
- `@genesiscz/utils/cli` (`runTool`, `suggestCommand`, `isInteractive`)
- `@genesiscz/utils/env` (`env.tools.getHome()`)

## V1 limits

- `message_id` runs from `0001` through `ffff` (65535 messages per session). Counter exhaustion is a hard error.
- `private:true` is stored in the feed but **not enforced** (anyone with FS access reads everything). V2 will add per-recipient sharding.
- No cross-session messaging. Each session is its own feed.
- No HTTP / TCP transport. Local FS only.
- One main per session (enforced via `is_main:true` uniqueness).
- Listener (`listen`) observes events; it does not send messages or interact with peers. Its session setup can reap stale locks.

## Build / test

```bash
tsgo --noEmit                                     # type-check
tools agents --help                               # show command tree
tools agents login --agent-main --agent-name lead --once --session demo
tools agents discover --session demo
```

## Why a CLI, not an MCP server?

The CLI lets any local worker send messages and receive JSONL without an MCP client. A host with a real monitor can turn login stdout into notifications. Other hosts explicitly await receive calls. Storing a shared feed, exposing stdout to a model, and scheduling an idle agent are separate responsibilities; the CLI provides the first two interfaces, while the host controls scheduling.

---

# `tools agents hooks` — the shell guard and the Bash diff watcher

A second, independent subsystem under the same tool. It has nothing to do with the messaging
feed above: it is the harness-hook side of `tools agents`, and it answers two questions on
every Bash call any coding agent makes.

1. **Would this command lie, or destroy work?** Fourteen built-in rules, each harvested from a
   real session where the shape produced a confidently wrong answer. `$?` after a pipeline,
   `2>/dev/null | wc -l`, `${PIPESTATUS[0]}` under zsh, `rg -rn`, `find` or `rg` from `~`,
   `git checkout --`, `push --force`, `(N)` globs, bare `log show`, `docker volume rm`, a stale
   SwiftPM plan. Your own rules load beside them (see **Custom rules** below).
2. **What did this command actually change?** A diff of exactly this command's edits, for the
   cases the harness's own renderer does not cover: a file outside the cwd repository, a
   second edit to the same file, an edit inside an untracked directory.

## Commands

```bash
tools agents hooks doctor                       # config, custom rules, per-harness wiring and when each was last seen
tools agents hooks rules list                   # every rule, built-in and custom: source, kind, severity, on/off
tools agents hooks rules explain <id>           # why the rule exists, wrong and right forms
tools agents hooks rules test '<command>'       # what would fire, and the resolved outcome, layer by layer
tools agents hooks rules check [--corpus 2000]  # every enabled rule against its own examples; replay recent commands
tools agents hooks log --decision block -n 50   # the decision log
tools agents hooks diff log --extended --since 6h   # each diff decision told against its call: command, files, what showed, why
tools agents hooks install --write              # wire the hooks into ~/.claude/settings.json, additively
tools agents hooks install --harness codex --write   # the same for Codex (<CODEX_HOME>/hooks.json)
tools agents hooks uninstall [--harness codex] --write   # remove exactly what install added
tools agents hooks gc --older-than 6h --write   # sweep captures whose command is over
tools agents hooks config rules                 # pick the rules that are on (a terminal gets a picker)
tools agents hooks config set shadow false --write
```

Every writing command is a **dry run by default**; `--write` applies it. The one exception is the
`config rules` picker in a terminal: saving the selection is the write.

## How a diff looks

`diff.theme` picks the look. `claude` (the default) copies Claude Code's own Bash diff in the theme
Claude Code is set to: a full-width band per changed row, syntax colour, old line numbers on removed
rows, brighter bands on the changed words, paths relative to the session folder. `claude-dark`,
`claude-light`, `claude-dark-daltonized`, `claude-light-daltonized`, `claude-dark-ansi` and
`claude-light-ansi` pin one palette; `classic` is the original look. `diff.columns` is `auto` (the
width of the terminal the harness draws in) or a number; `0` ends a band at its text.

```bash
tools agents hooks config set diff.theme claude --write
tools agents hooks config set diff.columns auto --write
```

The message has a budget of 9,900 characters (`diff.maxMessageChars`). Claude Code replaces a hook
message longer than 10,000 characters (`.length`, escape codes included) with "Output too large".
Every row carries its syntax colour and is wrapped at the terminal width before fitting. Changed
rows are bought first, together with the context row right above and below each change, then the
other context, nearest first. The full-width fill is bought last, from what is left.

`diff.highlight` sets the syntax colour, through `bat` (one run per syntax in a message):

| Mode | Characters | Risk |
|---|---|---|
| `256` (default) | about half of `truecolor` after compaction | colours are the nearest of the 256-colour palette; a terminal theme that remaps that palette can shift them |
| `truecolor` | the most; fewer lines fit the message | none on screen; a large diff shows fewer lines |
| `none` | the least | no syntax colour; bands and markers stay |

Every mode drops escape codes that change nothing (a reset before a new colour, a repeated colour,
colour on blanks); that loses no colour, so there is no raw mode. A message that cuts lines links
the call's full diff (`diff.fullDiff`: `genesis`, `path` or `off`). The `genesis` link is printed
only while the browser router routes Markdown on this Mac; otherwise the message names the path.
`tools agents hooks diff show <call>` prints it too.

`diff.fill` sets how far a changed row's band reaches. `block` (default) fills to the widest row of
the file. `terminal` fills to the pane's width, like Claude Code's own diff; but a hook message is fixed
text, so when the pane later gets narrower, every row wraps into an empty band row. `none` ends the band
with the text.

A file with more than `diff.maxBlockLines` (400) changed lines prints its header and a count only,
and the message links its full diff. A named file in a temp folder outside every git work tree (a
PR body, a repro script) is not printed unless `diff.showTempScratch` is on.

### What the hook leaves out

- A rebase that stopped, a cherry-pick, a merge or a `stash pop` brought content the command did
  not write: one line names how many files git changed. A commit made after it still renders.
- A file moved without a change (`git mv`) is one "moved unchanged" line, not a Deleted and an
  Added block.
- A file another agent's call is still working on, or a background call names, is that call's.
- A command that only reads gets no line about other writers.
- A background call is diffed when its task ends, and the next call of the session prints it under
  "background task <id> ended".
- A failed command's edits are diffed too (PostToolUseFailure), with a note that it failed.

### Claude Code's own Bash diff

With the hook drawing every Bash diff, `install --write` switches Claude Code's own one off
(`"bashEditDiffEnabled": false` in `~/.claude/settings.json`, while `diff.replaceNative` is on).
That one has no attribution: it shows whatever changed in the cwd repository during the call,
another session's edit included. `tools agents hooks native-diff [status|off|on] --write` sets it.

🛑 `CLAUDE_CODE_BASH_EDIT_DIFF=1` in a session's environment wins over the setting. `tools claude
start` set it on every launch until 2026-10-15; it now leaves it unset while the setting is off.
`doctor` and `native-diff` warn when the variable is set.

## Harnesses

| Harness | Wiring | Notes |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `install --write` |
| Codex | `<CODEX_HOME>/hooks.json` | `install --harness codex --write`. Codex trusts a hook by its position and content: it asks to review a new or changed one at its next interactive start and does not run it before that. The installer appends new entries and replaces its own in place, so hooks already trusted keep their position. |
| Grok | none of its own | Grok runs the hooks in Claude's `settings.json` |

`doctor` shows each harness's wiring and the last decision the log holds for it: a harness that
looks wired but never appears there is not running the hooks.

## Custom rules

Personal rules live in your own folder and run in the same guard. Point the config at files or
folders (`~` expands, a relative path resolves against the home folder):

```bash
tools agents hooks config set guard.customRules ~/my-hook-rules --write
```

Every top-level `.ts`, `.mts`, `.js` or `.mjs` file in a folder is one module (`*.test.*`,
`_drafts` and dotfiles are skipped). A module exports `rules` (or a default export): an array of
`ShellRule` from `@genesiscz/utils/shell/rules/types`, with helpers from
`@genesiscz/utils/shell/scan`. Outside this repository those imports resolve through the
`tsconfig.json` that `tools link install` writes (see `src/link/README.md`).

A rule is held to the built-in contract: a kebab-case id, a kind, a severity, a title, a causal
`why`, a `wrong` example it fires on and a `right` one it does not. `rules check` runs those
examples. Nothing a custom module does can break the guard: a module that fails to import,
exports the wrong shape or takes longer than 3 s to import is skipped; a rule whose `detect`
throws or returns something that is not a match is skipped for that command; an id that is
already taken (a built-in rule, or an earlier module) is refused. Each of these is written to
the decision log (`phase: "diag"`) and listed by `doctor`. With `guard.customRules` empty the
hook imports nothing.

## How the diff knows what changed

"What did this command change" is not "how does this file differ from HEAD". Two edits to one
file would re-print the first one, and a file that was already dirty would be blamed on this
command. So the PreToolUse phase captures the before-state, and the PostToolUse phase diffs
against that.

Only **dirty** files are captured: git already holds the before-state of every clean file, so
the capture stays small. Measured on this repository: 14 dirty files, 54 ms, one `git status`
and one `tar`. The capture lives under `$TMPDIR/GenesisTools/ai/hooks/data/<harness>/<session>/diff/<toolCallId>`,
keyed by tool call so two parallel Bash calls cannot clobber each other, and the post phase
deletes it. `gc` sweeps what a denied command, an interrupted turn or a crash leaves behind.

🔒 A capture holds copies of dirty files, which can include a `.env` a command just wrote, so
the directory is created **0700** and every file in it **0600**. `tmpdir()` is per-user and mode
700 on macOS, but a world-readable `/tmp` on Linux and in CI, so the platform is not relied on.
The decision log is 0600 in a 0700 directory for the same reason, and an existing log created
before this shipped is tightened in place on the first hook run.

Paths are read through `git status --porcelain=v2 -z` and the repository's own
`parseStatusPorcelainV2Z`. **`-z` is not a detail**: without it git C-quotes any path with a
space or a non-ASCII byte as `?? "a file.ts"`, and the hook then goes silent on a file that
plainly changed. Every git-derived file list handed to `tar` is preceded by `--`, or a
repository file named `-C` would be read as an option.

## Shadow mode

It ships **shadowed**: every hook decides and logs, and emits nothing. That is what lets it
run beside the implementation it replaces on real traffic, with no double-deny and no double
diff. Turn it on with `tools agents hooks config set shadow false --write`.

## Emergency stop

| Scope | How |
|---|---|
| One command | `AGENTS_HOOKS_DISABLE=1 <your command>` |
| This machine | `tools agents hooks config set guard.enabled false --write` |
| One rule | `tools agents hooks config rules --disable <rule-id> --write` |
| Unwire entirely | `tools agents hooks uninstall --write` |
| Stop logging commands | `tools agents hooks config set logCommands never --write` |

⚠️ Hook config is snapshotted at session start, so `uninstall` takes effect in the NEXT
session. The env var and the config file apply immediately.

`logCommands` defaults to `"shadow"`: the decision log keeps the command verbatim only while
the hooks are shadowed. Once shadow is off it stops, so the log does not become a durable
plaintext sink for whatever a command carries inline. `rules check --corpus` replays commands
from the Claude transcripts instead.

The log is also **bounded**. `maxLogBytes` (16 MB) rotates it to `<log>.1` and starts fresh,
keeping one generation, so the ceiling is twice the cap. The size is checked before EVERY
record, not once per process — the count is seeded from one `stat` and then tracked in memory,
so a long-lived writer rotates too and the hot path still pays no `stat` per record.
`tools agents hooks doctor` prints the cap.

## Layout

| Path | What |
|---|---|
| `src/utils/shell/scan.ts` | Tokenises a command into a `ShellScan`; no imports at all |
| `src/utils/shell/rules/*` | The fourteen built-in rules, one file per family, plus the registry |
| `src/agents/lib/hooks/custom-rules.ts` | Loads `guard.customRules` modules, crash-safe |
| `src/agents/lib/hooks/codex.ts` | Codex `hooks.json` install, uninstall and trust status |
| `src/agents/lib/hooks/*` | Config, outcome ladder, payload parsing, guard, log, state, gc |
| `src/agents/lib/hooks/diff/*` | Capture, collect, before-copy, render, post-phase orchestration |
| `src/agents/bin/hook-pre.ts` | PreToolUse: guard then capture, in one process |
| `src/agents/bin/hook-diff-post.ts` | PostToolUse: the diff |
| `src/agents/bin/hook-session-end.ts` | SessionEnd: sweep this session's captures |

🛑 Nothing under `src/agents/lib/hooks/**` may import `@genesiscz/utils/logger` or `Storage`.
Measured 2026-09-20: the pino facade costs 14.9 ms to import and `Storage` another 16.2 ms.
The enforced budgets are 30 ms for the guard stage and 110 ms for the pre phase
(`scripts/benchmarks/hooks/hook-latency.ts`), and this code runs on every Bash call, so two
imports worth 31 ms are not affordable. Diagnostics go through `hookDiag`, into the same JSONL
as the decisions.

## Proving a change

```bash
bun run test src/agents/ src/utils/shell/ src/utils/git/
tools agents hooks rules check --corpus 3000   # every rule's examples, then a replay of real commands
bun scripts/benchmarks/hooks/hook-latency.ts [--custom-rules <folder>]
```

The parity harnesses that compared this port with the GenesisClaude guard it replaced
(`scripts/hooks-parity.ts`, `hooks-diff-parity.ts`, `hooks-config-parity.ts`,
`hooks-shadow-report.ts`) were retired on 2026-10-12 together with that guard. Their last run:
3000 commands with 0 mismatches, 224 config resolutions with 0 mismatches, and 12 diff scenarios
with 0 mismatches (1 expected divergence: the old hook went silent on a C-quoted path).

---

# Is a background agent working, waiting, or stalled?

`src/utils/ai/transcripts/activity.ts` decides which of four states an agent is in. It was the core of the
removed `tools agent-watch`. No command calls it yet: `tools agents` is the message bus and never reads
transcripts, and the hub's agent status (`AgentStatus` in `src/hub/lib/agents/types.ts`) is a fixed contract
with the Swift app, so a fifth state there is a change on both sides.

| State | Meaning |
|---|---|
| `FINISHED` | An exit event, or the process is gone. |
| `AWAITING-INPUT` | The last conversation record is a finished turn or an `AskUserQuestion` call. A prompt is never a stall. |
| `STALLED` | Silent for longer than `stallTimeoutMs` (the newer of the last event and the file's mtime). |
| `RUNNING` | Anything else. |

```ts
import { readClaudeActivity } from "@genesiscz/utils/ai/transcripts/activity-tail";

// One stat and one 64 KB read of the end of the file. No spawn, no write.
const activity = readClaudeActivity(transcriptPath, { stallTimeoutMs: 120_000 });
// { state: "STALLED", lastActivityAt: 1760000000000, silenceMs: 241000 }, or null for an empty or unreadable file
```

The pure functions take everything as arguments, so a caller with its own reader can use them directly:
`classifyActivity` (the decision), `claudeRecordsToEvents` (Claude transcript records to events),
`taskLinesToEvents` and `taskPidAlive` (a `tools task` session and its sidecar, with `classifyPid` as the
probe) and `isNotableTransition` (alert once when an agent enters a notable state, not on every poll).

Two limits worth knowing. Records after the last conversation record (`cost-state`, `system`,
`queue-operation`) say nothing about the state, so they are skipped: 39 of the 40 most recent transcripts on
one machine ended on one (2026-10-05), and the old rule that read the final line labelled 39 of them
`STALLED` and none `AWAITING-INPUT`. And `listSubagents` (`src/utils/ai/transcripts/subagents.ts`) answers a
nearby question for sub-agents with a fixed 15 minute limit and no waiting state; the two are not merged.

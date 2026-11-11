# tools agents

`tools agents` is the toolkit for coding agents (Claude Code, Codex, Grok) that work on one Mac. It has three parts:

1. **A message bus.** Agents in one swarm (a lead and its workers) send each other messages through an append-only
   feed on disk. There is no daemon, no MCP server and no network.
2. **Harness hooks.** One set of hooks that every Bash call of every agent goes through: a shell guard that blocks
   commands whose output would lie or that would destroy work, a diff of exactly what the command changed, decision
   and question checks at the end of a turn, an unpushed-commits reminder, and the Claude Code mods plugin.
3. **A change log.** The hooks record every file an agent changes. `changes` shows one session's changes per turn,
   and `blame` tells which session and turn last wrote each line of a file.

For the protocol aimed at the agents themselves (which channel to pick per host, how to receive without blocking),
read the plugin skill [`plugins/genesis-tools/skills/agents-talk/SKILL.md`](../../plugins/genesis-tools/skills/agents-talk/SKILL.md)
(`genesis-tools:agents-talk`).

## Quick start

```bash
# The bus: the lead attaches and gets every message as a stream (run it under a Monitor)
tools agents login --agent-name lead --agent-main

# A worker in the same swarm sends the lead a message
tools agents message --from researcher --to lead --body 'Found the bug in auth.ts'

# The hooks: wire them into Claude Code (a dry run first, then --write)
tools agents hooks install
tools agents hooks install --write

# Is everything wired, and what is configured?
tools agents hooks doctor

# Would the guard stop this command, and why?
tools agents hooks rules test 'rg -rn token src'

# Which files did one session change, per turn?
tools agents changes 7399934a --last-turn --diff
```

Every hooks command that writes something is a **dry run by default**. Add `--write` to apply it.

## Commands

### The message bus

| Command | What it does |
|---|---|
| `login` | Attach as an agent and receive messages. Registers a new `--agent-name` on first use. |
| `message [body...]` | Send a message: direct (`--to`), broadcast (no `--to`), reply (`--reply`) or pure ack. |
| `request` | Send a message to one agent and block until the correlated reply arrives. |
| `leave` | Announce that an agent stops listening: one `agent_left`, which a login receives by its `--presence` mode (main by default). A Monitor re-arm posts no leave; a re-arm that fails posts one `lapsed` leave 90 s after the login ended. A hard-killed login (`SIGKILL`, a crash) writes nothing: its 90 s start only when a stale-lock sweep reaps its lock (`login`, `message`, `discover` and `listen` run one), so with no sweep no lapse comes. |
| `discover` | List every registered agent of the session. |
| `listen` | Follow a session feed in human-friendly form. Read-only. |

There is no `register` command: `login` registers on first use. There is no `respond` command: a reply is
`message --reply <msg-id>`. `request` is a thin send-and-wait over those same replies, not a second channel.

`message` sends only to agents on the bus. To reach a running Claude, Codex or Grok session that is not on the bus,
use `tools claude message <session>` (also `tools codex message` and `tools grok message`).

```bash
tools agents login --agent-name lead --agent-main              # registers, attaches, stream mode
tools agents login --agent-name researcher                     # a worker
tools agents login --agent-id agt_xxx --agent-name X           # attach with a chosen id
tools agents login --agent-name X --once                       # drain queued mail, or block for the first one
tools agents login --agent-name X --once --timeout 300         # give up after 300 s: {"type":"timeout"}, exit 124
tools agents login --agent-name X --format json                # JSON lines only
tools agents login --agent-name lead --kinds message,error     # receiver-side verbosity filter
tools agents login --agent-name lead --hide-worker-steps       # drop a Codex worker's per-step "item" events
tools agents login --agent-name lead --exclude-kinds item,turn_started
tools agents login --agent-name lead --filter '.op=="approval_request"'
tools agents login --agent-name lead --presence all           # which joins and leaves to receive: none (default for a non-main agent), changes (default for main), all
tools agents leave --agent-name X --note "done"
tools agents message --from X --to Y --body '...'
tools agents message --from X --body '...'                     # broadcast (no --to)
tools agents message --from X --reply 0001 --body '...'        # reply, routed to the original sender
tools agents message --from X --reply 0001                     # pure ack (no body)
tools agents message --from X --to Y --body-file /tmp/brief.md # long or multi-line body, no quoting trouble
tools agents request --from X --to Y --body 'approve?'         # waits up to --timeout (300 s)
tools agents discover                                          # table in a terminal, JSON otherwise
tools agents listen                                            # colored follower for a person
```

`login` flags:

| Flag | Meaning |
|---|---|
| `--agent-name <name>` | Unique per session. A new name registers. |
| `--agent-id <id>` | A chosen id. Generated when left out; `main_` prefix with `--agent-main`. |
| `--agent-main` | This agent is the session's main. One per session; needs `--agent-name`. |
| `--role <role>`, `--meta <json>` | Stored on the agent record. |
| `--debug` | Session debug mode: lifecycle events go to every agent. |
| `--once` | Read what is pending and exit, or wait for the first message. |
| `--timeout <s>` | With `--once` and no mail: print `{"type":"timeout"}` and exit 124. |
| `--observer` | Read-only. See ALL events, not only your own mail. |
| `--format <fmt>` | `monitor`, `json` or `pretty` (see [Output formats](#output-formats)). |
| `--kinds <csv>` | Emit only these feed types or message `op`/event kinds. |
| `--exclude-kinds <csv>` | Never emit these. Wins over `--kinds`. |
| `--hide-worker-steps` | Hide a `tools codex spawn` worker's `item` events; keep its mail, approvals, turn events. |
| `--filter <expr>` | Filter structured bodies, for example `.op=="approval_request"`. |
| `--presence <mode>` | Which joins and leaves to receive: `none`, `changes` or `all` (see [Who sees what](#who-sees-what)). |
| `--session <id>` | Override [session resolution](#session-resolution). |

Other flags: `message` has `--meta <json>` and `--private` (stored, not enforced). `listen` has `--session`,
`--session-name <name>` (the session whose main agent has this name), `--recent-hour` (pick only among sessions
active in the last hour) and `--format`. `discover` has `--format json|table`. Every bus command takes `--session`.

### Hooks: wiring and diagnosis

| Command | What it does |
|---|---|
| `hooks doctor [--json]` | Config, custom rules, wiring per harness, and when each harness was last seen. |
| `hooks install [--harness codex] --write` | Wire the hooks into a harness, additively. |
| `hooks uninstall [--harness codex] --write` | Remove exactly the entries `install` added (Claude: see below). |
| `hooks log` | Read the decision log. |
| `hooks chat-answers` | Review the chat-answer runs of the decision Stop hook. |
| `hooks native-diff [status\|off\|on] --write` | Claude Code's own Bash diff (`bashEditDiffEnabled`). |
| `hooks gc --write` | Remove captures whose command is over. |

```bash
tools agents hooks doctor                       # config, custom rules, wiring, last seen per harness
tools agents hooks install --write              # Claude Code: ~/.claude/settings.json
tools agents hooks install --harness codex --write   # Codex: <CODEX_HOME>/hooks.json
tools agents hooks uninstall [--harness codex] --write
tools agents hooks log --decision block -n 50   # the decision log
tools agents hooks log --fired -n 200           # weeks of blocks, notes and warnings
tools agents hooks chat-answers --misses        # user messages that matched no open decision
tools agents hooks native-diff status
tools agents hooks gc --older-than 6h --write
```

`install` flags: `--harness claude|codex` (default `claude`; Grok runs Claude's hooks), `--dist <path>` (the stable
path the entries call; default the agents dist symlink), `--target <path>` (Claude only: the checkout the dist
symlink points at; default this checkout), `--replace-subagent-line` (Claude only, see `mods.agentRow` below) and
`--write`.

For Claude Code, `uninstall --write` also undoes the two settings `install` changed. It puts `bashEditDiffEnabled`
back to the value saved at install, while it is still the `false` that `install` wrote (a value you set since stays).
It removes the `subagentStatusLine` that `install` wrote, or restores the one it replaced.

`log` flags: `--session <id>`, `--decision emitted|silent|skip|block|warn`, `-n, --lines <count>` (20), `--fired`.
`chat-answers` flags: `--session <id prefix>`, `--misses`, `-n, --runs <count>` (20), `--json`.
`gc` flags: `--older-than <duration>` (6h), `--session <id>` (this session, ignoring age), `--write`.

### Hooks: the shell rules

| Command | What it does |
|---|---|
| `hooks rules list [--json]` | Every rule, built-in and custom: source, kind, severity, on or off. |
| `hooks rules explain <id>` | Why the rule exists, with its wrong and right forms. |
| `hooks rules test '<command>'` | Which rules a command trips, and the resolved outcome, layer by layer. |
| `hooks rules check` | Run every enabled rule's own wrong and right examples. |

`rules test` takes `--harness claude|codex|grok` (default `claude`), `--model <id>` (for the model glob
overrides) and `--cwd <dir>` (for rules that read the project). `rules check` takes `--corpus [count]` (replay the
newest N unique Bash commands from the Claude transcripts, default 2000, and count what each rule fires on),
`--cwd <dir>` and `--json`. It exits 1 when an example fails, a custom module has a problem, or a rule throws.

### Hooks: the Bash diff

| Command | What it does |
|---|---|
| `hooks diff show <call>` | Print the full diff a cut message linked, by tool call id or a prefix of it. |
| `hooks diff log` | What the diff hook decided per Bash call. |

`diff log` flags: `--session <id prefix>`, `--since <duration>` (24h), `--decision <list>` (`emitted`, `noted`,
`failed`, `silent`, `skip` or `all`; default `emitted,noted,failed`), `-n, --lines <count>` (50), `--extended`
(join each call with its Claude transcript: the command, what the message showed, and Claude Code's own diff),
`--full-command` (each command whole in a fence; implies `--extended`) and `--json`.

```bash
tools agents hooks diff log --extended --since 6h
tools agents hooks diff show toolu_01abc
```

### Hooks: the config

| Command | What it does |
|---|---|
| `hooks config show` | The config in effect, after defaults. |
| `hooks config path` | Where the config file lives. |
| `hooks config rules` | Switch rules on and off. A terminal gets a picker. |
| `hooks config set <key> <value> --write` | Change one setting. |

`hooks config` alone runs `config show`. `config rules` in a terminal opens a picker, and saving the selection is the
write. Elsewhere, or with flags, it prints the list and takes `--enable <ids>` and `--disable <ids>` (comma lists)
with `--write`. `config set` takes `--replace-subagent-line` and `--write`. Its keys are listed under
[Configuration](#configuration).

```bash
tools agents hooks config set shadow false --write
tools agents hooks config set rules.find-from-root allow --write
tools agents hooks config rules --disable zsh-word-split --write
```

### Hooks: the Claude Code mods

| Command | What it does |
|---|---|
| `hooks mods status` | Whether the mods plugin is installed and enabled, and what the config sets for it. |
| `hooks mods install [--scope user] --write` | Install `genesis-tools-mods` from this repository's marketplace. |
| `hooks mods uninstall --write` | Uninstall the plugin. |
| `hooks mods enable <names...> --write` | Turn mods on by name, or `all`. |
| `hooks mods disable <names...> --write` | Turn mods off by name, or `all`. |
| `hooks mods watch [--off] --write` | Load the mods from this checkout in every new session, reload on each save. |

`hooks mods` alone runs `mods status`. `mods install --scope` is `user` (default), `project` or `local`. The mod
names are `diff`, `idleCompact`, `agentModel`, `agentRow`, `decisions`, `inbox`, `links`, `git`, `askRow`, `spinner`,
`cacheBand`, `tmpUsage`, `agentsBand`, `hooks`, `hooksDedupe` and `stall`. `enable` and `disable` take
`--replace-subagent-line` for `agentRow`. `mods watch` writes the folder into `CLAUDE_CODE_PLUGIN_DIRS` in the `env`
block of the Claude settings; `--off` takes it out.

### The change log

| Command | What it does |
|---|---|
| `changes <session>` | The files one agent session changed, per turn. |
| `blame --files <paths...>` | Which session and turn last wrote each line of these files. Read-only. |

`changes` reads the file-tool edits from the transcript and the shell changes from the change log, and leaves out
automatic changes (checkouts, builds, tests, logs, caches). A leading part of a session id is completed from the
history index; an ambiguous prefix is refused with the candidates. Flags:

| Flag | Meaning |
|---|---|
| `--turn <id>` | One turn. |
| `--last-turn` | The last turn that changed a file. |
| `--last-turns <n>` | The last N turns that changed a file (the hub's "Last N turns"). |
| `--tool <id>` | Only the files one tool call changed, each with its unified diff. |
| `--tools <ids>` | Several tool calls (comma list), as JSON `{ tools: [{ toolUseId, files, excluded }] }`. |
| `--diff` | Add a unified diff to every file (a budget per file; always on with `--tool`). |
| `--raw` | The change log as recorded: no transcript, no exclusions. Takes `--tool`, not `--tools`. |
| `--store-blobs` | Also write the transcript's before and after blobs into the object store. |
| `--json` | Machine-readable output. |

`--tool` and `--tools` cannot be combined. Without `--store-blobs`, `changes` writes nothing.

`blame` flags: `--files <paths...>` (required; paths relative to `--repo`, one argument each, so a path may hold a
comma), `--repo <path>` (default `.`; its other worktrees count too), `--since <iso>` (default 30 days ago) and
`--json`.

```bash
tools agents changes 7399934a --last-turns 3 --json
tools agents changes 7399934a --tool toolu_01abc
tools agents blame --repo ~/Projects/app --files src/auth.ts src/db.ts
```

---

## The message bus

Each session has an append-only feed at `~/.genesis-tools/agents/<session-id>/feed.jsonl`. Every agent of the swarm
reads and writes that one file.

### Session resolution

Every bus command picks the session in this order:

1. `--session <id>`.
2. `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION`. `tools codex spawn` and `tools grok spawn` set the
   second one: it is the parent saying which swarm to join.
3. The host session id: `$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`, `$GROK_SESSION_ID`,
   `$COPILOT_AGENT_SESSION_ID`. When several are set (a worker inherits its parent's), the one whose swarm ALREADY
   EXISTS wins, so a worker joins its parent instead of starting an orphan swarm. If none exists, the first present
   id creates one.
4. The single session whose feed changed in the last 60 seconds.
5. Otherwise a friendly error that asks for `--session` or one of those variables.

### Who sees what

The **main** agent's login stream is the swarm inbox: it receives every `message` except its own sends, so a parent
Monitor on `tools agents login --agent-main` sees peer-to-peer hops too. Other agents see only mail addressed to them,
plus broadcasts. `--observer` sees everything and sends nothing.

**Who receives presence.** A login's `--presence` mode decides which joins and leaves it gets: `none` for an agent
that is not main (in the 2026-11-08 swarm, 28% of the child turns woke only on a peer's join or leave), `changes`
for main (joins and real departures; it hides the `signal` and `timeout` leaves an older version wrote), `all` for
everyone in a `--debug` session. An explicit `--presence` wins. `--kinds` filters presence like any other type:
`--kinds message` hides it, `--kinds message,agent_left` keeps the leaves. An agent never receives presence from
before it registered.

**Joining.** `{"type":"agent_joined","agent_name":…,"present":[…]}` is written when an agent comes onto the bus (its
first login, or its first after a leave or a lapse). A `--once` receiver's later cycles and a Monitor re-arm are not
joins, so presence costs one event at each end and nothing per message or per re-arm.

**Re-arming.** A login that ends by a signal (a harness Monitor expires after 30 minutes and kills it), by a
`--once --timeout`, or as a reaped dead login writes `logged_out` with `login_id` and `rearm_until` (90 s later) and
no leave. The agent stays on the bus, and its next login inside the grace is silent. When no new login came by
`rearm_until`, one `agent_left` with `reason: "lapsed"` and `lapsed_since` is written. Every watching login checks
for a due lapse every 5 s, and every `login`, `message`, `discover` and `listen` checks once; the decision is made
under the feed lock, so a lapse is written once. A login that a later login of the same agent already replaced
cannot start a grace: its late `logged_out` is ignored.

**A hard-killed login.** A login killed with `SIGKILL` (or a crash) writes no `logged_out`, and a watching login does
not look for dead slots. Its grace starts only when a stale-lock sweep reaps the dead lock, and every `login`,
`message`, `discover` and `listen` runs that sweep first. Until one of them runs, the agent stays on the bus and no
lapse is written. To recover, run `tools agents discover --session <id>` (or send the agent a message): the sweep
writes the `logged_out` with `rearm_until`, and the lapse follows 90 s later when no new login comes.

**Leaving.** `{"type":"agent_left","agent_name":…,"reason":…,"remaining":[…]}` is written when an agent runs `leave`
(`leave`, with its `--note`), when a re-arm lapses (`lapsed`), when a stream login stops on its own (`ended`), and
when a `--once` receiver waited the whole cap (`cap`). A `--once` cycle that ends on mail is not leaving. `remaining`
names the agents that logged in and have not left since. Feeds from before 2026-11-10 also hold `signal`, `timeout`
and `dead_pid` leaves.

**Send receipt.** `message` adds `not_listening` (`[{agent_id, name, state, since, reason}]`, state `rearming`,
`left` or `never_logged_in`) and a one-sentence `note` to its JSON result when a named recipient will not read the
message now. A recipient must be registered (its first login registers it): an unknown name fails the send and
stores nothing, so `never_logged_in` names only an agent that is registered and has no login yet. For a registered
recipient the message is stored whether it listens or not, and it reaches the recipient at its next login whose
filters (`--kinds`, `--exclude-kinds`, `--filter`) let it through; a login that filters it out moves its cursor past
it (see [Delivery and latency limits](#delivery-and-latency-limits)). The sender is never in `not_listening`: its own
login never shows its own message, and `message` warns when the sender is among the recipients. This is how an agent
without presence events learns that its peer is away.

### Output formats

`login` prints one `{"type":"ready",...}` event on stdout as soon as the slot is attached (it is not written to the
feed). After that, stdout carries feed events only. When stderr is not a terminal (piped into a harness monitor),
`login` writes nothing to stderr, so a diagnostic cannot be mistaken for an event.

`--format` (on `login` and `listen`):

- `monitor`, the default when stdout is not a terminal: each event is a one-line headline, then the event's JSON line
  (the same text `json` prints). Claude Code draws the first line of a Monitor event as its row, so the row reads
  `Monitor event: message: reviewer → lead: Review done. ⏎ Two findings: …` instead of a cut-off JSON object, and the
  model still gets the JSON. The headline never starts with `{`, repeats at most 200 characters of a body on one line,
  and names agents by name (unique per session). Events written together start with `[i/N]`, because the row shows
  only the first headline.
- `json`: one JSON object per line. Use it when a program parses every line. A plain `login` in a terminal prints it.
- `pretty`: colored text for a terminal. It is the `listen` default in a terminal, and the `login --observer` default
  in a terminal.

### Codex and hosts without a monitor

Check the tools each agent has. Prefer native collaboration for Codex agents that can all use it. Use this bus for
cross-host workers, agents without native peer messaging, shared feed history, broadcast, and correlated replies. A
parent that has a tool does not prove that every child has it.

With a real monitor, subscribe to `login` stdout directly. Without one, an active agent awaits `login --once` or
resumes that command's existing terminal execution handle. A terminal handle does not subscribe the model to future
stdout. `--once` drains every queued matching event; with no match it blocks for up to eight hours. Never start a
second receiver for the same identity.

In Codex tool sets that expose `collaboration.send_message` and `followup_task`, the first sends to an agent without
starting an idle turn, and the second starts an idle turn. `wait_agent` waits for native events, not CLI stdout. The
skill has the wake and receiver rules per host.

For nonblocking talk between working Codex agents, send the full payload with the native tool and continue useful
work. Incoming native messages are injected at message boundaries; receiving needs no login, poll or wait call. Use
`followup_task` with the payload when the recipient may be idle. If a child lacks native peer tools and there is no
real monitor, a blocking `--once` receiver does not meet a nonblocking requirement.

### Delivery and latency limits

The login cursor advances after writing stdout, and it also advances past filtered events. It does not acknowledge
that the model read the event or finished the work. A reconnect can skip output the harness dropped, or repeat an
emission that was interrupted before its cursor write. Send an explicit reply after processing when that confirmation
matters.

`login` and `listen` react to filesystem notifications with no deliberate debounce. A fallback check runs every
150 ms for `login` and every 1000 ms for `listen`. CLI startup, full-feed parsing, scheduling and model turns add
latency. A running receiver cannot wake an idle model by itself.

### Files per session

| Path under `~/.genesis-tools/agents/<session>/` | What |
|---|---|
| `feed.jsonl` | Append-only event log with a monotonic `seq`. The single source of truth. |
| `session-meta.json` | Session-wide flags (`{debug}`). |
| `slots/<id>.login` | Live login PID lock, one per attached agent. |
| `slots/<id>.cursor` | Per-agent delivery cursor `{seq}`. Also the only dedup mechanism. |

The registry (who registered, who is logged in) is derived by replaying `feed.jsonl` on every read. There is no
`registry.json` and no counter file.

### V1 limits

- `message_id` runs from `0001` to `ffff` (65,535 messages per session). Running out is a hard error.
- `--private` is stored in the feed but **not enforced**: anyone with file access reads everything. V2 is to add
  per-recipient sharding.
- No messages across sessions. Each session is its own feed.
- No HTTP or TCP transport. Local files only.
- One main per session (`is_main:true` is unique).
- `listen` observes events; it does not send or interact. Its session setup can reap stale locks.

### Why a CLI, not an MCP server?

The CLI lets any local worker send messages and receive JSONL without an MCP client. A host with a real monitor turns
`login` stdout into notifications; other hosts await receive calls explicitly. Storing a shared feed, exposing stdout
to a model and scheduling an idle agent are three separate jobs: the CLI provides the first two, and the host does
the scheduling. The design notes and research behind this live in the tool's local design notes, which are
gitignored and not part of a clone.

---

## The hooks

The hooks subsystem has nothing to do with the bus. It answers questions on every Bash call any coding agent makes,
and on a few other harness events:

1. **Would this command lie, or destroy work?** The shell guard (27 built-in rules plus your own).
2. **What did this command actually change?** The Bash diff, for the cases the harness's own renderer does not cover:
   a file outside the cwd repository, a second edit to the same file, an edit inside an untracked directory.
3. **Did the reply ask the user something that never reached the inbox?** The decision checks at Stop.
4. **Is the agent waiting on a question?** The structural questions feature.
5. **Are commits piling up unpushed?** The unpushed reminder at Stop.

### What `install` wires (Claude Code)

The entries call scripts under `src/agents/bin/` through a symlink the installer owns,
`~/.genesis-tools/agents/hooks-dist`. `settings.json` is machine-wide, so an absolute path into a branch worktree
would make every session on the Mac run branch code, and deleting that worktree would break every Bash call. Moving
every session to another checkout is one repoint of the symlink (`install --target <checkout> --write`).

| Event | Script | Wired while |
|---|---|---|
| PreToolUse (Bash) | `hook-pre.ts`: the guard, then the diff capture, in one process | always |
| PostToolUse (Bash, Edit, MultiEdit, Write) | `hook-diff-post.ts`: the diff and the change log | always |
| PostToolUseFailure (Bash) | `hook-diff-post.ts` | always |
| SessionEnd | `hook-session-end.ts`: sweep this session's captures | always |
| Stop | `hook-stop.ts`: decisions, question nudge, chat answers, unpushed | one of those is on (unpushed is on by default) |
| UserPromptSubmit | `hook-prompt.ts`: hand answered decisions to the next prompt | `decisions.stopHook`, `harvest` or `injectAnswers` |
| Question events | `hook-question.ts` | `questions.claude` or `questions.grok` is on |

A failed Bash call gets no PostToolUse, so its edits were never shown: 98 failed calls in a day, 48 of them editing
files (2026-10-14). That is why PostToolUseFailure has its own entry.

The Bash entries are written whatever the config says; `guard.enabled` and `diff.enabled` switch the work off inside
them. `doctor` lists what is wired. Every entry has a 15 s timeout (10 s for `hook-question.ts`).

### Harnesses

| Harness | Wiring | Notes |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `install --write` |
| Codex | `<CODEX_HOME>/hooks.json` | `install --harness codex --write`: the guard, plus the Bash diff while it is on for Codex. |
| Grok | none of its own | Grok runs the hooks in Claude's `settings.json`. |

Codex gets only two entries: PreToolUse (Bash) with the guard and the capture, and PostToolUse (Bash) while its diff
is on. It gets no Stop entry, so the `decisions.*` checks, the question nudge, chat answers and the unpushed reminder
do not run in Codex, although `decisions.harnesses` names it by default. It gets no PostToolUseFailure entry, so a
failed Codex Bash call is not diffed. It gets no SessionEnd entry, so its leftover captures go with `gc`, or with the
sweep of captures older than an hour that every Claude Code session end runs. Only `Bash` is matched:
Codex edits files through `apply_patch`, so those edits never reach the change log, and `changes` reads them from the
Codex transcript instead.

Codex trusts a hook by its position and content: it asks to review a new or changed one at its next interactive start
and does not run it before that. The installer appends new entries and replaces its own in place, so hooks that are
already trusted keep their position.

`doctor` shows each harness's wiring and the last decision the log holds for it. A harness that looks wired but never
appears there is not running the hooks.

### Shadow mode

The hooks ship **shadowed**: every hook decides and logs, and emits nothing. That let them run beside the
implementation they replaced on real traffic, with no double deny and no double diff. Turn shadow off to let them
speak:

```bash
tools agents hooks config set shadow false --write
```

### The shell guard

Each rule was harvested from a real session where the command shape produced a confidently wrong answer or lost work.
There are 27 built-in rules: 23 shell rules in `src/utils/shell/rules/` and 4 about GenesisTools' own commands in
`src/agents/lib/hooks/tool-rules.ts` (those sit apart because the shell rules are copied into another repository
where `tools` is a different binary). `tools agents hooks rules list` prints them all with their state.

- **Pipelines and exit codes:** `$?` after a pipeline, `${PIPESTATUS[0]}` under zsh, `$pipestatus[N]` reading the
  wrong element, `$?` after a filter such as `grep` or `jq`.
- **Discarded stderr:** `2>/dev/null` and then a count or a read, where a failure reads as `0` or as an absence; `dd
  skip=` with `status=none`.
- **Search:** `rg -rn` (`-r` is `--replace`), `find`, `fd`, `rg` or `grep -r` started at `/`, `~` or the home root.
- **git:** `git checkout --` and `git restore` over uncommitted work, `git push --force` without a lease.
- **zsh:** `(N)` and `(#q…)` glob qualifiers, bare `log show` (the zsh builtin), an unquoted `$var` that holds a list.
- **Tools:** a stale SwiftPM build plan, `docker volume rm` and prune, `biome --write --unsafe` deleting comments.
- **GenesisTools:** `tools rm` verbs that are the person's to run (`approve`, `roots add`, `config set`, profile
  changes, `drain --now`), plain `rm` instead of `tools rm`, loose scratch outside `/tmp/cc/<project>/<session>/`,
  and moving a file into scratch to skip the approval.

Each rule has a kind (`misread` or `destructive`) and a severity (`block`, `warn` or `context`). The outcome of a rule
for one call is resolved in this order: the rule's own severity, then `rules.<id>` (the `default` map), then
`harnesses.<harness>.<id>`, then the first matching `models` glob (`opus` matches exactly; `opus[*` and `*sonnet*`
are globs; case-insensitive). The first matching model pattern ends the search, even when it has no override for this
rule. Last comes the length downgrade: at or above `guard.longCommand.lines` (30) or `guard.longCommand.chars`
(2,500), a `misread` block becomes a warn, because re-running a long script over one line costs more than reading the
note. A `destructive` rule always blocks, whatever the length.

The outcomes are `allow`, `context` (a note to the model), `warn` and `block`. A `context` note is shown at most
`guard.contextCapPerSession` (3) times per rule per session, then the rule goes quiet. Codex and Grok ship with
`zsh-glob-qualifier` allowed, because their own zsh honours `(N)`; only Claude Code sets `NO_BARE_GLOB_QUAL`.

A **deny** prints the rule's wrong and right forms, and the corrected command when the guard can derive it safely. A
**warn** or a note means the command already ran, and one stated part of its output cannot be trusted.

### Custom rules

Personal rules live in your own folder and run in the same guard. Point the config at files or folders (`~` expands;
a relative path resolves against the home folder; a comma list sets several; an empty value clears it):

```bash
tools agents hooks config set guard.customRules ~/my-hook-rules --write
```

Every top-level `.ts`, `.mts`, `.js` or `.mjs` file in a folder is one module (`*.test.*`, `_drafts` and dotfiles are
skipped). A module exports `rules` (or a default export): an array of `ShellRule` from
`@genesiscz/utils/shell/rules/types`, with helpers from `@genesiscz/utils/shell/scan`. Outside this repository those
imports resolve through the `tsconfig.json` that `tools link install` writes (see [`../link/README.md`](../link/README.md)).

A rule is held to the built-in contract: a kebab-case id, a kind, a severity, a title, a causal `why`, a `wrong`
example it fires on and a `right` one it does not. `rules check` runs those examples. Nothing a custom module does can
break the guard:

- A module that fails to import, exports the wrong shape, or takes longer than 3 s to import is skipped.
- A rule whose `detect` throws, or returns something that is not a match, is skipped for that command.
- An id that is already taken (by a built-in rule or an earlier module) is refused.

Each of these goes to the decision log (`phase: "diag"`) and is listed by `doctor`. Only a shell call loads the custom
modules, and with `guard.customRules` empty the hook imports nothing.

### The Bash diff

#### How a diff looks

`diff.theme` picks the look. `claude` (the default) copies Claude Code's own Bash diff in the theme Claude Code is
set to: a full-width band per changed row, syntax colour, old line numbers on removed rows, brighter bands on the
changed words, paths relative to the session folder. `claude-dark`, `claude-light`, `claude-dark-daltonized`,
`claude-light-daltonized`, `claude-dark-ansi` and `claude-light-ansi` pin one palette; `classic` is the original look.
`diff.columns` is `auto` (the width of the terminal the harness draws in) or a number; `0` ends a band at its text.

```bash
tools agents hooks config set diff.theme claude --write
tools agents hooks config set diff.columns auto --write
```

The message has a budget of 9,900 characters (`diff.maxMessageChars`). Claude Code replaces a hook message longer
than 10,000 characters (`.length`, escape codes included) with "Output too large". The budget used to be 9,000 bytes,
an inference from 206 measured messages that matched the real rule only by luck. Every row carries its syntax colour
and is wrapped at the terminal width before fitting. Changed rows are bought first, together with the context row
right above and below each change, then the other context, nearest first. The full-width fill is bought last, from
what is left. One message names at most `diff.maxFiles` (15) files and `diff.maxLinesPerFile` (30) lines per file.

`diff.highlighter` picks what paints the syntax colour. `hljs` (default) is highlight.js in process, in Claude Code's
own dark palette (Monokai Extended, 24 scopes). It loads in about 7 ms once, then costs 0.3 ms a call, and on three
samples of this repository wrote about half the characters of `bat` (5,539 against 10,934 for 90 lines of
TypeScript; 146 colour switches against 387). `bat` is one process per syntax in a message (25 ms median) in `bat`'s
own theme. A file type the painter does not know (`.txt`, `.env`), a text none of whose scopes has a colour in that
palette (Markdown), and every light theme go to `bat`.

`diff.highlight` sets how much colour is written, for either painter:

| Mode | Characters | Risk |
|---|---|---|
| `256` (default) | about half of `truecolor` | nearest 256-palette colour; a theme that remaps it shifts them |
| `truecolor` | the most | none on screen; a large diff shows fewer lines |
| `none` | the least | no syntax colour; bands and markers stay |

Every mode drops escape codes that change nothing (a reset before a new colour, a repeated colour, colour on blanks).
That loses no colour, so there is no raw mode.

`diff.fill` sets how far a changed row's band reaches. `block` (default) fills to the widest row of the file, but
never past `diff.fillMax` columns (72; 0 lifts the limit). Without that limit, one long line made every row as wide as
the pane, and every row wrapped into an empty band row when the pane got narrower. A row longer than the limit is not
padded. `terminal` fills to the pane's width, like Claude Code's own diff, but a hook message is fixed text, so a
pane that later gets narrower wraps every row into an empty band row. `none` ends the band with the text.

The message starts with the call's command, dim: its first `diff.commandLines` lines (3; 0 shows none), each cut to
80 characters, then how many lines were left out. Claude Code folds a finished call into "ran N shell commands" and
leaves only the hook message under the fold, so without them nothing says which command changed the files.

A message that cuts lines links the call's full diff (`diff.fullDiff`: `genesis`, `path` or `off`). The full diff is
`~/.genesis-tools/agents/hook-diffs/<call>.md`, kept a week. The `genesis` link is printed only while the browser
router routes Markdown on this Mac; otherwise the message names the path. `tools agents hooks diff show <call>`
prints it too.

A file or a whole folder moved with `mv` or `git mv` is one line, `old/ → new/ (284 files)`, when the new copies match
the old ones byte for byte (up to 4,000 files; a file over 4 MiB is not compared).

A file with more than `diff.maxBlockLines` (400) changed lines prints its header and a count only, and the message
links its full diff.

#### Which files it watches

- Files inside the git roots the command works in.
- Files the command **names** as a path (`diff.watchNamedPaths`, on), so an edit to a note, a `~/.claude` memory file
  or any path outside the cwd repository shows at all. At most `diff.maxNamedPaths` (8) per call, each a `stat` and a
  clone.
- A named file in a temp folder outside every git work tree (a PR body, a repro script) is printed while
  `diff.showTempScratch` is on. It is on since 2026-11-01: work in the session's scratch folder printed nothing, and
  that read as a broken diff. It was off from 2026-10-15, after 146 such blocks in one day (2026-10-14).
- A file the command CREATED and that is known only because the command named it stays hidden
  (`diff.namedPathsShowCreated`, off): measured 2026-09-21, two calls in a row each wrote a report into the temp
  folder and each got a 30-line block of a file the command had just described.
- Kinds of change (`diff.categories` in the file): `source` and `formatting` are on; `log` and `generated` are off.
  A jest run redirected into a log file and cut by the next run rendered as 27 lines of stack trace nobody asked for.

#### What the hook leaves out

- A change this session did not cause (another session's edit in a shared repository, or anything a read-only command
  could not have written) is never diffed. `diff.othersSummary` `line` (default) names such files in one short line;
  `hidden` drops them. With `diff.dedupeAcrossSessions` (on), one file change prints at most once across every session
  on the machine.
- A rebase that stopped, a cherry-pick, a merge or a `stash pop` brought content the command did not write: one line
  names how many files git changed. A commit made after it still renders.
- A file moved without a change (`git mv`) is one "moved unchanged" line, not a Deleted and an Added block.
- A file another agent's call is still working on, or that a background call names, is that call's.
- A command that only reads gets no line about other writers.
- A background call is diffed when its task ends, and the next call of the session prints it under "background task
  <id> ended", after that call's own diff. Ended tasks share half of the message; one that no longer fits waits for
  the next call.
- A failed command's edits are diffed too (PostToolUseFailure), with a note that it failed.

#### How the diff knows what changed

"What did this command change" is not "how does this file differ from HEAD". Two edits to one file would re-print the
first one, and a file that was already dirty would be blamed on this command. So the PreToolUse phase captures the
before-state, and the PostToolUse phase diffs against it.

Only **dirty** files are captured: git already holds the before-state of every clean file, so the capture stays
small. Measured on this repository: 14 dirty files, 54 ms, one `git status` and one `tar`. The capture lives under
`$TMPDIR/GenesisTools/ai/hooks/data/<harness>/<session>/diff/<toolCallId>`, keyed by tool call so two parallel Bash
calls cannot clobber each other, and the post phase deletes it. `gc` sweeps what a denied command, an interrupted turn
or a crash leaves behind, and the SessionEnd hook sweeps the session's own captures. A harness whose diff is off pays
for no capture: no `git status`, no `tar`, no copies. (The path says `ai` while the command is `agents`: the older
hook wrote that tree, and renaming it would orphan every capture already on disk from `gc`.)

🔒 A capture holds copies of dirty files, which can include a `.env` a command just wrote, so the directory is created
**0700** and every file in it **0600**. `tmpdir()` is per-user and mode 700 on macOS, but a world-readable `/tmp` on
Linux and in CI, so the platform is not relied on. The decision log is 0600 in a 0700 directory for the same reason,
and a log created before this shipped is tightened in place on the first hook run.

Paths are read through `git status --porcelain=v2 -z` and the repository's own `parseStatusPorcelainV2Z`. **`-z` is
not a detail**: without it git C-quotes any path with a space or a non-ASCII byte as `?? "a file.ts"`, and the hook
then goes silent on a file that plainly changed. Every git-derived file list handed to `tar` is preceded by `--`, or a
repository file named `-C` would be read as an option.

#### Claude Code's own Bash diff

With the hook drawing every Bash diff, `install --write` switches Claude Code's own one off
(`"bashEditDiffEnabled": false` in `~/.claude/settings.json`) once `shadow` is off and `diff.replaceNative` is on.
While `shadow` is on the hook prints nothing, so that diff stays. Claude Code's diff has no attribution: it shows
whatever changed in the cwd repository during the call, another session's edit included.
`tools agents hooks native-diff [status|off|on] --write` sets it.

🛑 `CLAUDE_CODE_BASH_EDIT_DIFF=1` in a session's environment wins over the setting. `tools claude start` set it on
every launch until 2026-10-15; it now leaves it unset while the setting is off. `doctor` and `native-diff` warn when
the variable is set.

### Decisions at the end of a turn

The decision hub's hooks work with [`tools question`](../question/README.md). Each is a key under `decisions.*`. The
checks ship **off**; `harvestListed` and the staleness notification ship on.

- `decisions.stopHook` (`off`, `warn`, `block`): a final reply that asks `❓ DECISION N` without posting it through
  `question_post`. `warn` tells the user; `block` sends the agent back to post it, at most
  `decisions.maxBlocksPerSession` (2) times per session, then it only warns (the loop guard).
- `decisions.questionNudge` (`off`, `warn`, `block`): see [The question nudge](#the-question-nudge).
- `decisions.chatAnswers` (`off`, `record`, `remind`): see [Chat answers](#chat-answers).
- `decisions.harvest` (off): a safety net that stores an unposted `❓ DECISION N` block as an open decision under its
  number.
- `decisions.harvestListed` (on): the inbox (`tools question inbox`, the hub) stores the unposted blocks it lists as
  open decisions, so the widget counts them too. Before, the widget read the decision log only and counted one fewer
  than the hub (2026-10-27). The agent's own later post of that number becomes the decision's next revision.
- `decisions.injectAnswers` (off): on UserPromptSubmit, hand answered and undelivered decisions to the session's next
  prompt.
- `decisions.harnesses`: a comma list of the harnesses the checks run for (default all three).
- `decisions.staleness.warnAfterMinutes` (30), `.alarmAfterMinutes` (120), `.notify` (on): a blocking decision still
  waiting this long raises one notification per threshold. `tools question stale --notify` reads it, and
  `tools question stale --install` runs that every 5 minutes.

#### The question nudge

`decisions.questionNudge` catches a final reply that asks the user to decide something that never reached the widget
inbox. It fires when the reply's own prose (fenced code, inline code and `>` quoted lines left out) holds a cue, the
word `decision`, `decisions`, `decide` or `choose` in any case or `❓`, and a sentence that ends in `?`, while this
session posted no decision since the turn's prompt. The provider reader's `readTurnBoundary` finds that prompt: its
timestamp for Claude and Codex, or its byte offset for timestamp-free Grok. Grok can check explicitly named decisions
against the log, but cannot time-match an unnamed post to a prompt.

`block` sends the agent back once per turn, quoting the question, to post it with `question_post` as type `decision`
or to say in one line that it is not a decision for the user. A second Stop of the turn always passes (Claude's
`stop_hook_active`, or the turn it already spoke in), and past `decisions.maxBlocksPerSession` blocks it only warns;
its blocks are counted apart from `stopHook`'s. A reply that names `❓ DECISION N` stays with `decisions.stopHook`. It
needs only the Stop entry, which `doctor` lists as `Stop hook`. The widget settings (Widgets > General > Agents) switch
it too.

```bash
tools agents hooks config set decisions.questionNudge block --write
tools agents hooks install --write   # only when doctor says the Stop hook is not wired
```

#### Chat answers

`decisions.chatAnswers` finds answers the user typed in the chat to an open `❓ DECISION N` of the session: `D14 b)`,
`14 b`, `DECISION 14: b`, `D14: own words`, several on one line split by `,` or `;`, or a bare `b)` right after a reply
that asked one decision. Text blocks from the same transcript message are combined before matching. A colon introduces
own words (`D14: I prefer Atlas`); an option's explanation needs an explicit separator (`D14 b) because`,
`D14 b - because` or `D14 b: because`). An option alone after a colon still selects that option when the decision
offers choices (`DECISION 14: b`).

At the end of each turn the Stop hook reads the transcript from its end back to the oldest open ask, or to its
previous read when that is later, through the session's provider (`NativeSessionReader.readBackward`, so Claude, Codex
and Grok each read their own format). It keeps the whole message at the read boundary, and looks only at user messages
written after each decision was asked. A revised decision needs timestamped evidence to find the current revision, so
timestamp-free Grok answers to a revised decision are left open for explicit recording with `question_update`.
Fenced code, inline code, indented examples and block quotes are left out. A bare option applies only to the first
real user response to the reply right before it.

- `record` checks the matched decision revision under the store lock, stores an unambiguous answer as `acknowledged`
  with `answeredVia: "automatic_heuristic"` and the user's line as a comment, and says so.
- `remind` stores nothing and sends the agent back to record it.
- An unclear answer (two different answers, a letter the decision does not have, `D14` named without an option) sends
  the agent back once per decision, quoting the line.
- Letters closed one by one (`D14: a) b)`) are one set.
- An answer that rules a letter out (`D14: a) b) not e)`, `D14 (a, c) - except d)`) is clear, but the hook never
  stores it, in either mode: its words say more than its letters, so it sends the agent back once to record it with
  its reading of them.

A read that ends before the oldest open ask is logged to the hooks log. A failed answer write or an incomplete read
keeps the previous cursor, so the next Stop can retry. It needs only the Stop entry.

Every completed chat-answer read, an empty one included, is logged to `~/.genesis-tools/agents/chat-answers.jsonl`:
the open decisions, each user message read (its start, plus any later line that names a decision or opens with an
option letter), and what came of it. `tools agents hooks chat-answers --misses` lists the messages that matched
nothing while decisions were open, so an answer the finder should have taken is found in a minute.

```bash
tools agents hooks config set decisions.chatAnswers record --write
tools agents hooks chat-answers --misses
```

### Structural questions (`questions`)

An agent that asks through its own harness never writes `❓ DECISION N`: Claude's `AskUserQuestion` and
`ExitPlanMode`, Codex's `request_user_input` (sync and async), Grok's `ask_user_question` and `exit_plan_mode`, and the
permission prompts of Claude and Grok. The `questions` feature records each one as a dialog record, one JSON file per
session under `~/.genesis-tools/agents/dialogs/<provider>/<sessionId>.json` (`src/utils/agents/dialogs/store.ts`). The
hub inbox lists every open record as a waiting decision with the badge count, a banner goes out for a newly open one
(`questions.notify`, on), and the answer-delivery guard refuses to type free text into a session while one is open.

**One identity everywhere: `provider:sessionId:toolCallId`** (`openQuestionKey`). The hook, the hub watcher, the inbox
item id and the guard all use it, so a question that both a hook and the watcher see is one record and one item. The
call id is Claude's `tool_use_id`, Codex's `call_id` or Grok's `toolCallId`. A Claude permission notification names no
call, so it is `permission:<ISO time>`. A Grok permission prompt takes the id of the open `tool_call` it asks for
(`events.jsonl` names only the tool; `TurnSnapshot.questionCall` pairs it).

Everything ships off, per harness:

```bash
tools agents hooks config set questions on --write          # every harness
tools agents hooks config set questions.claude on --write   # one harness: claude, codex or grok
tools agents hooks config set questions.notify false --write
tools agents hooks install --write   # wires the Claude/Grok entries; `questions off` + install removes exactly them
```

How each harness is served:

- **Claude:** `hook-question.ts` opens a record on PreToolUse (`AskUserQuestion|ExitPlanMode`) and on Notification
  (`permission_prompt`). Its PostToolUse or PostToolUseFailure closes it; any tool's PostToolUse closes the permission
  prompts; UserPromptSubmit and SessionEnd close all.
- **Grok:** the same entries (Grok runs Claude's `settings.json`; the matcher also names
  `ask_user_question|exit_plan_mode`), plus the hub watcher for permission prompts, which no Grok hook sees
  (`pre_tool_use` fires before the prompt). The watcher closes its own records.
- **Codex:** the hub watcher (`readTurnState`, `request_user_input`), because Codex hooks reach shell calls only. The
  watcher closes the record when the turn state no longer waits.

The watcher (`src/utils/agents/dialogs/watcher.ts`) runs inside `loadInbox` for the listed sessions of a harness with
`questions` on that wrote within 24 hours. It re-reads a session only when its transcript or event log changed
(`turnStateSources`), reads bounded tails (256 KB of transcript, 64 KB of Grok `events.jsonl`), writes records with
`source: "watcher"`, and never rewrites or closes a hook's record. Codex approval prompts are not covered: its
rollouts persist no approval request.

`hook-question.ts` is one bun start. A PostToolUse of a session with no dialog record file exits after one `stat`
(`questions-gate.ts`), before `questions.ts` loads the store and its logger. Each change goes to the hooks log as
`phase: "question"`.

### The unpushed reminder

At Stop, the hook reminds the agent about commits that are not pushed yet. It fires for a branch with an upstream when
more than `unpushed.maxCommits` (3) commits are unpushed, or when the oldest unpushed commit is older than
`unpushed.maxAgeMinutes` (60), whichever comes first. It reminds once per repository per
`unpushed.remindEveryMinutes` (30), across every session on the machine. It never pushes. It is **on** by default
(`unpushed.enabled`), so `install` wires the Stop entry even with every decision check off.

### The agents-talk hint

`agentsTalk.hint` (on) lets the genesis-tools plugin's SessionStart hook remind the session about the `agents-talk`
skill. The plugin hook reads the key itself, so these hooks wire nothing for it.

### The Claude Code mods

`tools agents hooks mods install --write` installs the plugin `genesis-tools-mods` from this repository's marketplace
(`plugins/genesis-tools-mods/`). The plugin reads the `mods` section of the hooks file itself, so a change to a
`mods.*` key needs no reinstall. A session that was running at the install needs `/reload-plugins` once. A session
that loads the folder through `CLAUDE_CODE_PLUGIN_DIRS` (the shell, or the `env` block of `~/.claude/settings.json`;
`mods watch` writes it) reloads the mods by itself when a file in the folder is saved. The mod API is early access in
Claude Code (2.1.287 and later), so a release can change it; the mod then draws nothing and the hook message is
unchanged. Its tests run with `claude plugin test plugins/genesis-tools-mods`.

Each feature is an object under `mods` in the hooks file. `mods enable git agentsBand --write` turns mods on by name
(`all` is every mod, `disable` turns them off, `mods status` shows each one). `config set mods.<feature> true --write`
does the same for one (it means `mods.<feature>.enabled`). The flat keys from before 2026-10-23 (`mods.fullDiff`,
`mods.idleCompactMinutes`, …) are still read and still set. The plugin reads the file as the CLI does: a value equal to
the file's `_shippedDefaults` copy (the defaults on the day it was written) follows today's default. On 2026-10-23 the
plugin still read raw values, so a file written while the new mods shipped on kept them on in the sessions, the CLI
read them as off, and the next `mods enable` wrote them off. Each feature appends what it did to
`~/.genesis-tools/agents/mods-log/<feature>.jsonl`, so its heuristics can be checked against real use
(`mods.log.readings`, off, also logs the routine refreshes, batched by file).

#### The full-diff mod (`mods.diff`, on)

When a hook message cut lines, the mod draws the call's whole diff (the `hook-diffs/<call>.md` note) with Claude
Code's own diff element under the call's row, so the 10,000-character message limit no longer hides the rest. It draws
nothing while `diff.fullDiff` is `off`. `config set mods.diff.fullDiff false --write` turns it off without an
uninstall.

Installing the plugin is not what makes the diff hook stand down. On every turn the loaded mod sets
`GENESIS_TOOLS_MODS_SESSION` to the id of its session, and only a Claude call whose session id equals that value, with
`mods.diff.fullDiff` on, gets no diff printed by the hook. The hook then writes every diff to its note and the mod
draws it, so it is not drawn twice. The mod may be loaded from any settings scope or with `--plugin-dir`. A session
that has not loaded it (started before the install and not reloaded, or a nested session that inherited another
session's id) keeps the hook's own message, and so does a marked session whose settings now disable the plugin, until
it reloads. Codex and Grok always keep the hook's message.

Each file has a `[-]` / `[+]` button that folds its diff to its name and back, and `[ files only ]` above them folds
every file; a click on the diff itself still opens the group's calls. The diff of a call that runs `git pull`,
`merge`, `rebase`, `checkout`, `switch`, `reset`, `cherry-pick`, `revert`, `am` or `stash pop|apply` starts hidden
behind one `[ show diff from git pull ]` button, because it is other people's work arriving.
`config set mods.diff.collapseGitSync false --write` draws it like any other call.

#### The idle-compaction mod (`mods.idleCompact`, on)

The plugin compacts an idle Claude session 56 minutes after its last turn (`mods.idleCompact.minutes`, 1 to 59),
while the 1-hour prompt cache is still warm, so the next prompt does not pay for the whole context again. Claude Code's
own idle compaction tries once at 54 minutes and gives up at its first refused check (a rate-limit warning on the last
reply is enough). The mod does not run that check, so a compaction can be spent while the account is in its warning.
It skips a session that compacted after its last turn, a context under `mods.idleCompact.minTokens` (200,000) and a
session with no screen (`claude -p`), and it appends a notice that starts `Compacted while idle`.
`config set mods.idleCompact false --write` turns it off, also for a timer already armed. A reload of the mod drops the
timer until the next turn ends.

#### The daily mods (all off by default)

- `mods.agentModel` (`format` `label`, `short` or `version`): `sonnet · Pair one`, `(S) Pair one` or
  `(S5.5) Pair one` on a subagent's rows.
- `mods.agentRow` (`format` `version`, `label` or `short`; `effort` on): the agents panel under the prompt names each
  subagent's model and effort beside its type, `general-purpose · O5.5(xhigh)  Reading foo.ts  1m 5s · ↓ 58k tokens`
  (`label`: `opus-5-5 (xhigh)`, `short`: `O(xhigh)`; `mods.agentRow.effort false` drops the effort). No mod hook
  reaches that panel, so this is Claude Code's `subagentStatusLine` setting: `mods enable agentRow --write`,
  `config set mods.agentRow.enabled true --write` (and `hooks install --write` while it is on) write it into
  `~/.claude/settings.json`, pointing at `src/agents/bin/hook-subagent-line.ts`. Disabling through either settings
  command removes it, or restores the command saved by `--replace-subagent-line`, which both commands accept. A
  `subagentStatusLine` of your own is left alone without that flag. Claude Code runs the command every 5 s, so the
  time on a row moves in 5 s steps.
- `mods.decisions` (`chip` `any`, `expand` `waiting`, `history` `collapsed` or `shown`, `enter` `stage-then-send`):
  the Decisions sidebar, opened by `/decisions` or the band's `decisions 1 waiting` chip. It lists every
  `❓ DECISION N` of the session from the decision log (`tools question inbox --session <id> --json --all-items`)
  and from its messages. The waiting ones come first; each opens to its options: a press stages an option, the
  field stages your own words (a long answer grows the field over several lines). Under them, the Staged section
  shows the exact message `send` submits (the CLI builds it, `stagedSendText`), with `send` (hotkey `s`),
  `put in prompt` and `clear` right below. The answered, done and closed decisions follow, folded under one
  `show N answered` row while `history` is `collapsed`, and listed open with `shown`; an opened one marks the picked
  option and shows the answer given. `jump to` scrolls the transcript to where a decision was first asked; a row from
  before a compaction is not drawn, so it opens the transcript search there instead
  (`tools claude cmux find --decision`). `chip` `waiting` shows the chip only while a decision waits, `off` never;
  `expand` `all` or `none` opens every row or none. `enter` `stage-then-send`: Enter on a staged,
  unchanged answer sends every staged answer (a terminal does not pass Cmd+Enter to a mod's field); `stage` only
  stages.
- `mods.inbox` (`chip` `any`, `expand` `none`): the Inbox sidebar, opened by `/mod-inbox` or the band's `inbox 2 new`
  chip. It lists what the session put in the GenesisTools inbox: the forms it waits on, the messages it sent, the
  questions and answers it recorded, and its todos. An entry opens to its text, `jump to` (the tool call that sent it)
  and its images. `new` is an entry nobody read in the widget yet. `chip` `unread` shows the chip only while one is
  new; `expand` `unread` or `all` opens those rows at the start.
- `mods.links`: the main loop's reply is linked as it streams, one line at a time. A path that exists (absolute, `~/`,
  relative to the working folder or the repository, or a bare file name a tool of the session named), with an
  optional `:line` or `:line-line`, a commit SHA that `git cat-file` knows, and a repeated `❓ DECISION N` become
  links. Code fences, inline code that does not resolve, existing links and URLs stay as they are. A genesis.tools
  link is written only for a kind `tools genesis-tools probe` says opens on this Mac (the plugin's `genesis.ts` runs
  it once per 30 minutes; no `tools` means no such links). Otherwise a note gets its `cursor://` or plain path, and a
  folder, a commit or a decision stays text.
- `mods.git` (`labels` `full` or `minimal`): a band line above the prompt with the branch, unpushed and unpulled
  commits, the changed files with their added and removed lines (`↑14 to push · ↓2 to pull 4 files changed +120 −30`,
  or `↑14 ↓2 ●4 +120 −30` with `minimal`), and the PRs (the branch's own and the ones `/mod-git pr add 42` tracks)
  with CI counts. See [The git band](#the-git-band) below.
- `mods.sidebar` (`hints` on, `feedback` `line`, `toast` or `both`, `focus` `command`, `always` or `never`): a sidebar
  ends in a status bar of its own, pinned to the pane's foot when the content fits, which says what the focused button
  does and, after a press, what happened (`… Reading 3 checkouts…`, then `✓ Read 3 checkouts again.`). Nothing above
  it moves when the focus does. The engine runs no plugin code on hover, so the bar follows the focus ring: Tab moves
  it, Enter presses, Esc gives the keys back. `focus` says when a docked sidebar takes the keys as it opens: `command`
  (the default) when its slash command (`/mod-git`) opened it, not on a band click, so typing stays in the prompt.
  Times in the sidebars and the band are live (`hooks/live.ts`): a time with seconds redraws each second while it is
  on screen, one in minutes each minute, and nothing redraws while no live time shows.
- `mods.askRow`: `[ask]` beside a finished tool row puts the row, quoted, into the prompt.
- `mods.spinner`: the spinner line names the running tool, its time and the working subagents.
- `mods.cacheBand` (`cautionMinutes` 20, `warnMinutes` 10, `others` on): the prompt cache countdown, yellow under
  `cautionMinutes` and red under `warnMinutes`, and the other sessions whose cache runs out within the yellow window. A
  press on another session's chip focuses the cmux pane it runs in. The own chip adds `AC in 1m 22s` while the idle
  compaction is armed, and says `compacted 4m ago · cache restarts` after a compaction: the next prompt then starts a
  new, small context, so there is no cache to keep warm. Another session that compacted gives no warning.
- `mods.tmpUsage` (`minutes` 5): what the session keeps on disk and the free disk
  (`tmp: session 4.2G · 1 worktree · disk free 5.0G`). The session's share is its `/tmp/cc` scratch folder, Claude
  Code's task output for it (`/tmp/claude-<uid>/…/<session>`) and every git worktree it made or holds: one its
  subagents got (`isolation: "worktree"`), one under its scratch folder's `worktrees/`, one locked to it. A worktree
  inside the scratch folder counts once. A press on the row (or `/mod-tmp`) opens the Session files sidebar: each
  folder and worktree by size, with its branch, changed files, lock and source, `Finder` and `copy path`.
- `mods.agentsBand` (`warnMinutes` 60): one band row per working subagent with model, age, idle time and tool calls;
  more than three fold into one `▸ 8 agents` line. A press on an agent, or `/mod-agents`, opens the Agents sidebar:
  its recent tools, what it said last, and `message`, `ask about it`, `stop`, `copy id` and `copy transcript path`.
- `mods.stall` (`action` `button` or `auto`, `minutes` 5): when a main-loop reply ends on what it was about to do
  (`Next I'll run the tests.`) and nothing can wake the session, the band shows `⏸ stopped on "…"` with `continue` and
  `dismiss`. `continue` sends a prompt that quotes the sentence, and `auto` sends it by itself after `minutes`. It
  never fires while anything runs: the Stop hook's `background_tasks` (shells, monitors, subagents, workflows) or
  `session_crons` not empty, an agent of `$.agent.list()` pending, running or waiting, or a Stop input without the task
  list. The sentence tests are the session-analyzer's stall scorer: the last sentence only, and a conditional ("I'll
  report when it fires"), a negated ("I won't …") or a gated reply ("waiting for your answer") is no stall. A tool call
  or a new turn takes the row down. Each finding and press goes to `mods-log/stall.jsonl`.
- `mods.hooks` (`tokens`, `dedupe`; mod names `hooks` and `hooksDedupe`): a band chip counts what the settings and
  plugin hooks handed the model in this session (`hooks ~38.2k · 41`, characters / 4). A press on it, or `/mod-hooks`,
  opens the Hooks sidebar with the count per event, the latest injections and a dedupe switch for the session. With
  `dedupe`, a block already handed to the same loop since its last compaction is replaced with a one-line receipt.

The sidebars dock beside the transcript in a fullscreen session and open as a dialog above the prompt otherwise, as
Claude Code's own `/diff` panel does. The plugin cannot choose (`$.ui.open` takes no placement). A second press on the
chip, or the same command again, closes one.

#### The git band

A press on the branch or a PR, or a bare `/mod-git`, opens the Git sidebar: each PR's title, failing and pending
checks, and `open`, `hub`, `copy link` and `track` buttons. `/mod-git on|off|toggle|refresh`.

- **Which checkouts.** The band has one line per checkout the session works in, the last first, up to `checkouts`
  (default 3, at most 6). A checkout counts once the session writes a file in it that git does not ignore, or runs a
  git command that changes it (`git -C <dir> commit`, `cd <dir> && git rebase`, `git worktree add <path>`, a folder in
  a variable the same command set: `W=/tmp/x` then `git -C "$W" commit`). Reads and `git status` count nothing. A
  session that has no record yet starts from its GenesisTools file journal. So a session started in the main checkout
  that works in two worktrees shows the two worktrees.
- **`cwd`** `touched` (the default) shows the session's own folder only when the session worked there, or when it has
  worked nowhere yet; `always` shows it first.
- **`name`** `repo-folder` (the default) names a linked worktree `app/feature-x` and a main checkout `app`; `repo`
  gives the main checkout's name alone, `folder` the checkout's own folder. The sidebar says where a linked worktree
  is.
- **`earlier`** `show` (the default) keeps the session's earlier work in view: each checkout remembers the branches
  the session worked on there (checked out at a write, or made or pushed by a command: `switch -c`, `checkout -b`,
  `worktree add -b`, `push origin <branch>`), so the PR of a branch it switched away from stays in the row, and a
  worktree it removed keeps its row (`worktree removed`) with its last branch and that branch's PRs, read in the main
  checkout. Such a row goes once the branch and its PRs are gone too. `hide` shows only what the checkouts have now.
- **Fitting.** Each line fits the band's width: the counts and the PRs keep theirs, and the checkout name (at most 40%
  of what is left when both cannot fit) and the branch keep their start and end. Only the first line shares the hooks
  chip. When the words do not fit, every line says its counts in signs (`↑27 ↓2 ●13 +862 −125`), then the PRs as bare
  numbers.
- **Adding and removing.** `/mod-git add <folder>` (the prompt's typeahead proposes folders, zoxide's first when it is
  installed, so `myap` finds `~/Projects/myapp`) and the sidebar's field put any checkout in this session's band.
  `/mod-git remove <folder>` and the sidebar's `remove` take it out, and `hide` drops a worked-in checkout until the
  session works there again. `/mod-git pr add` acts on the first line's checkout.
- **PRs.** In the sidebar, a PR's `track` keeps it in its checkout's line after a branch switch (`/mod-git pr add`).
  The branch's own PR shows anyway, so its `hide` takes it out of the band and `show` puts it back. A failing or
  pending check shows what it said (`✗ Vercel · Deployment was blocked`, from `gh pr checks`) and opens its page on
  Enter.
- **The sidebar** folds each checkout to one line with its state in signs (`▸ app feat/… ↑24 ●16 #98 ✓1`); Enter or a
  click opens it to its state, its actions and its PRs. `expand` (`first`, `all` or `none`, default `first`) says
  which start open.

### Logs

| File | What |
|---|---|
| `~/.genesis-tools/logs/agents-hooks.jsonl` | The decision log: every hook decision and diagnostic (`hooks log`). |
| `~/.genesis-tools/logs/agents-hooks-fired.jsonl` | Every guard decision that was not an allow (`hooks log --fired`). |
| `~/.genesis-tools/agents/chat-answers.jsonl` | Every chat-answer read (`hooks chat-answers`). |
| `~/.genesis-tools/agents/mods-log/<feature>.jsonl` | What each mod did. |

`logCommands` defaults to `shadow`: the decision log keeps the command verbatim only while the hooks are shadowed
(`always` and `never` are the other values). Once shadow is off it stops, so the log does not become a durable
plaintext sink for whatever a command carries inline (`export API_KEY=…`). `rules check --corpus` replays commands
from the Claude transcripts instead.

The log is also **bounded**. `maxLogMB` (16; older files may carry the byte cap `maxLogBytes`, which is still read)
rotates it to `<log>.1` and starts fresh, keeping one generation, so the ceiling is twice the cap. Allowed calls fill
that in about a day, so every guard decision that is not an allow also goes to `agents-hooks-fired.jsonl` beside it,
under the same cap, which holds weeks of firings for an audit. The size is checked before EVERY record, not once per
process: the count is seeded from one `stat` and then tracked in memory, so a long-lived writer rotates too and the
hot path pays no `stat` per record. `doctor` prints the cap.

### Emergency stop

| Scope | How |
|---|---|
| One command | `AGENTS_HOOKS_DISABLE=1 <your command>` |
| This machine | `tools agents hooks config set guard.enabled false --write` |
| One rule | `tools agents hooks config rules --disable <rule-id> --write` |
| Unwire entirely | `tools agents hooks uninstall --write` |
| Stop logging commands | `tools agents hooks config set logCommands never --write` |

`AGENTS_HOOKS_DISABLE=1` makes every `tools agents` hook exit 0 at once.

⚠️ Hook config is snapshotted at session start, so `uninstall` takes effect in the NEXT session. The environment
variable and the config file apply at once.

---

## The change log

The PostToolUse hook records every file an agent changes, by Bash or by a file tool (Edit, MultiEdit, Write), in
`~/.genesis-tools/agents/<session>/changes.jsonl`. A row holds the provider, session, turn, tool, tool call id, cwd,
path, the before and after blob ids, and the source (`edit`, `write` or `bash`). A Bash row also holds when its command
began (rows from 2026-11-02 on), so a reader can tell a file the command made from one it only changed. A side that is
binary or larger than 2 MB is not stored, and the row says why (`binary` or `large`). Rows from before 2026-09-24 name
no tool calls, and rows from before 2026-09-25 do not say which side was skipped.

- `tools agents changes <session>` joins the change log with the session's transcript and shows the files per turn,
  without automatic changes. The hub's "Last N turns" view uses it (`--last-turns`).
- `tools agents blame` reads the change logs of the last 30 days (the 400 newest logs at most) and tells, per line range of each
  file, the provider, session, time and the turn's prompt (Claude transcripts) of the last change that added that
  text. A line shorter than 3 characters (a lone brace) says nothing about its author and is skipped. A line diff that
  runs past 200 ms gives up and that change attributes nothing, rather than stall the blame.

```text
src/auth.ts
  12-40  claude 7399934a 2026-11-08T14:02:11Z  fix the token refresh race
3 of 4 files have agent lines; 212 logs, 5120 rows, 840 ms
```

### The object store

The hooks write the before and after bytes of every changed file into one bare git repository,
`~/.genesis-tools/agents/_objects` (`src/utils/agents/objects/store.ts`), and each row of a change log names its
blobs by oid. 🛑 The store has no refs, so to git every object is unreachable: `git gc`, `git prune` or
`git repack -a -d` would drop or skip all of them. What a reader needs comes from the rows. Never run those commands
against the store.

```bash
tools compress daily --dry-run   # the daily pass's plan, its agents-objects step included; changes nothing
tools compress daily             # the daily pass now: the logs, then agents-objects under its lock
```

- **When:** the `agents-objects` step of the logger's once-a-day pass (`runDailyCompression` in
  `src/utils/compress/daily.ts`, detached at low priority). It writes one before/after log line.
- **What stays:** every blob a row of the last 30 days names, in one pack that `pack-objects` builds from that list,
  with the row's path as the delta hint (1.14 GiB of loose objects pack to 227 MB; a later pass reuses the deltas and
  takes seconds). A loose copy goes only when the new pack's own index lists it and `git verify-pack` reads every
  object of the pack back (5 s for the 195 MB pack on 2026-11-02). A new pack that fails either check is removed and
  the step stops with nothing else removed. A loose blob no row names stays while it is younger than 30 days (a hook
  writes the blob before its row; `changes --store-blobs` writes blobs a reader then asks for).
- **Why 30 days:** `tools agents blame` reads 30 days by default (`OBJECT_RETENTION_DAYS`, shared). An older row keeps
  its file list, and its diff shows as `missing-blob`.
- **Racing hooks:** dropped objects move aside first; 20 s later (longer than a hook's budget) the rows written
  meanwhile are read, and any object they name comes back. A change log is read in 1 MiB chunks, and that second read
  starts where the first stopped, so memory stays one chunk however long a session's log grows. One step runs at a
  time (`gt-maintenance/lock` in the store). The store gets `gc.auto=0` and `gc.pruneExpire=never` when it is made and
  on every pass, so no git command can start a gc that prunes it.
- **Fail closed:** a change log that exists but cannot be read (a permission or I/O error) stops the step before
  anything moves; only a missing log names nothing. A pack moves aside as a whole pair: both files are hard-linked
  under `gt-maintenance/retired-*` before the store's copies go, the index first. The next step's recovery puts back a
  pack a dead step left half moved, and keeps the moved-aside folder while an object it holds does not read back.
  `tools compress daily` exits 1 when the step failed or found its lock held, or when a log file did not compress,
  with `--json` too.

---

## How it works

Everything is local. Nothing calls the network and nothing costs money, except that the git band (`mods.git`) asks
`gh` for PR and check state.

| Path | What |
|---|---|
| `~/.genesis-tools/agents/<session>/` | The bus feed, slots and session flags; the session's `changes.jsonl`. |
| `~/.genesis-tools/agents/hooks.json` | The hooks config. |
| `~/.genesis-tools/agents/hooks-dist` | The symlink the hook entries call; it points at a checkout. |
| `~/.genesis-tools/agents/_objects` | The change-log object store (bare git, no refs). |
| `~/.genesis-tools/agents/hook-diffs/<call>.md` | Full diffs of cut messages, kept a week. |
| `~/.genesis-tools/agents/dialogs/<provider>/` | Structural question records. |
| `~/.genesis-tools/agents/chat-answers.jsonl` | The chat-answer read log. |
| `~/.genesis-tools/agents/mods-log/` | One log per mod. |
| `~/.genesis-tools/logs/agents-hooks*.jsonl` | The decision log and the fired log. |
| `$TMPDIR/GenesisTools/ai/hooks/` | Per-call captures, claims, mentions, the unpushed cache. |
| `~/.claude/settings.json` | Claude Code wiring, `bashEditDiffEnabled`, `subagentStatusLine` (`CLAUDE_CONFIG_DIR` moves it). |
| `<CODEX_HOME>/hooks.json` | Codex wiring. |

The hooks run `bun` on the scripts in `src/agents/bin/`. The diff calls `git` and `tar`, and `bat` for the syntax it
paints. The questions watcher runs inside the hub inbox (`loadInbox`). The mods need the Claude Code mod API (2.1.287
and later).

### Hook latency

🛑 Nothing under `src/agents/lib/hooks/**` may import `@genesiscz/utils/logger` or `Storage`. Measured 2026-09-20: the
pino facade costs 14.9 ms to import and `Storage` another 16.2 ms. The enforced budgets
(`scripts/benchmarks/hooks/hook-latency.ts`) are 30 ms for the guard stage, 110 ms for the pre phase and 30 ms for a
post phase with no change. This code runs on every Bash call, so two imports worth 31 ms are not affordable.
Diagnostics go through `hookDiag`, into the same JSONL as the decisions. The PreToolUse phase is one process because
two entrypoints cost 18.9 ms + 75.6 ms (2026-09-20), and a bun start plus the import graph is about 10 ms of that,
paid twice. The guard runs first, and a denied command skips the capture.

## Configuration

The hooks config is `~/.genesis-tools/agents/hooks.json` (`tools agents hooks config path`). Writers store EVERY
setting, so each knob is visible and editable in the file, plus a `_shippedDefaults` copy: a value equal to that copy
follows today's default. Change it with `config set <key> <value> --write`, or edit the file. `config show` prints
the config in effect. `doctor` reports a value that does not parse, and the default is used instead.

| Key | Default | What |
|---|---|---|
| `shadow` | `true` | Decide and log, emit nothing. |
| `logCommands` | `shadow` | Keep the command in the log: `shadow`, `always`, `never`. |
| `maxLogMB` | `16` | Log rotation cap. |
| `enabled` / `guard.enabled` | `true` | The shell guard. |
| `rules.<rule-id>` | rule severity | `allow`, `context`, `warn` or `block` for every harness. |
| `harnesses.<harness>.<rule-id>` | | The same for one harness. |
| `guard.longCommand.lines` / `.chars` | `30` / `2500` | Long-command downgrade. |
| `guard.contextCapPerSession` | `3` | Context notes per rule per session. |
| `guard.customRules` | empty | Comma list of rule files or folders. |
| `diff.enabled` | `true` | The Bash diff (Grok: off). |
| `diff.maxFiles` / `diff.maxLinesPerFile` | `15` / `30` | Files and lines per message. |
| `diff.maxBlockLines` | `400` | Past it, a header and a count only. |
| `diff.maxMessageChars` | `9900` | Message budget. |
| `diff.maxCaptureMB` / `diff.maxCaptureFileMB` | `8` / `0.256` | Capture caps. |
| `diff.clone.maxFileMB` / `diff.maxNamedPathMB` | `2` / `2` | Clone and named-path copy caps. |
| `diff.theme` | `claude` | See [How a diff looks](#how-a-diff-looks). |
| `diff.highlight` / `diff.highlighter` | `256` / `hljs` | Colour depth and painter. |
| `diff.fill` / `diff.fillMax` | `block` / `72` | Band reach. |
| `diff.columns` | `auto` | Band width. |
| `diff.commandLines` | `3` | Command lines heading a message. |
| `diff.fullDiff` | `genesis` | `genesis`, `path`, `off`. |
| `diff.replaceNative` | `true` | Turn Claude Code's own diff off at install. |
| `diff.showTempScratch` | `true` | Show named temp files. |
| `diff.othersSummary` | `line` | `line` or `hidden`. |
| `diff.harnesses.<harness>.<field>` | | Per-harness diff overrides. |
| `unpushed.enabled` | `true` | The unpushed reminder. |
| `unpushed.maxCommits` / `.maxAgeMinutes` | `3` / `60` | When it fires. |
| `unpushed.remindEveryMinutes` | `30` | Once per repository per interval. |
| `decisions.*` | off, but `harvestListed` and `staleness.notify` on | See [Decisions](#decisions-at-the-end-of-a-turn). |
| `questions`, `questions.<harness>` | off | See [Structural questions](#structural-questions-questions). |
| `questions.notify` | `true` | Banner for a new open question. |
| `agentsTalk.hint` | `true` | The agents-talk SessionStart reminder. |
| `mods.*` | see above | See [The Claude Code mods](#the-claude-code-mods). |

`config set --help` prints the full key list. Keys in the file that `set` does not take: `logPath` (the decision log,
default `~/.genesis-tools/logs/agents-hooks.jsonl`; the fired log sits beside it), `guard.models` (model globs, see
the guard), `diff.categories`, `diff.watchNamedPaths`, `diff.maxNamedPaths`, `diff.namedPathsShowCreated`,
`diff.dedupeAcrossSessions`, `diff.standDownWhenNative`, `diff.contextLines` (3), `diff.maxRoots` (4),
`diff.maxCaptureFiles` (400) and `diff.untrackedExpansionCap` (200). `diff.standDownWhenNative` (on) skips a file that
Claude Code's own Bash diff already drew for the same call, so it is not printed twice.

Environment variables:

| Variable | What |
|---|---|
| `AGENTS_HOOKS_DISABLE=1` | Every hook exits 0 at once. |
| `GENESIS_AGENTS_SESSION` | The bus session to use. |
| `GT_RENDEZVOUS_SESSION` | The swarm a spawned worker joins (set by `tools codex spawn`, `tools grok spawn`). |
| `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GROK_SESSION_ID`, `COPILOT_AGENT_SESSION_ID` | Host ids for session resolution. |
| `GENESIS_TOOLS_MODS_SESSION` | Set by the loaded mod; the diff hook stands down for that session. |
| `CLAUDE_CODE_BASH_EDIT_DIFF=1` | Turns Claude Code's own diff on, whatever the setting. |
| `CODEX_HOME` | Where Codex's `hooks.json` is. |
| `CLAUDE_CONFIG_DIR` | Moves the `settings.json` that `install`, `native-diff` and `mods` write (default `~/.claude`). |
| `CLAUDE_CODE_PLUGIN_DIRS` | Folders Claude Code loads plugins from (`mods watch`). |

## For agents

- Read the skill first: [`agents-talk`](../../plugins/genesis-tools/skills/agents-talk/SKILL.md). It routes by host
  (Claude agent-team teammate, plain background agent, Grok worker, Codex) and says which receiver to run.
- Receive with a Monitor on `tools agents login --agent-name <you>`. Without a monitor, use
  `login --once [--timeout <s>]`, which exits 124 with `{"type":"timeout"}` when it gives up. Never run two receivers
  for one identity.
- Piped `login` and `listen` print the `monitor` format (a headline line, then the JSON line); `--format json` prints
  JSON only. `discover`, `hooks rules list`, `rules check`, `hooks doctor`, `chat-answers`, `diff log`, `changes` and
  `blame` take `--json` (or `--format json`).
- `request` prints the reply as JSON, and fails with "timed out after Nms" after `--timeout` (300 s).
- Send a long body with `--body-file`, not a quoted `--body`.
- A guard **deny** is a real defect in the command: run the corrected command it prints (or follow the rule's right
  form when it prints none), never the same command
  through `bash -c`, a heredoc or a script file. A **warn** or note means the command ran and one part of its output
  cannot be trusted.
- `hooks rules check` exits 1 on a failed example, a custom module problem or a rule that throws.

## Troubleshooting

- **`login` says it could not resolve a session.** None of `--session`, the session variables or a host id was there,
  and no session, or more than one, was active in the last 60 s. Pass `--session <id>` or set `GENESIS_AGENTS_SESSION`.
- **A session id or agent id is refused.** The message names the cause:
  - `contains a control character`: captured terminal output (escape codes or a newline) was passed instead of an id.
  - `is N characters long`: a whole command output was passed. The limit is `MAX_SESSION_ID_LENGTH`.
  - `is not a valid path segment`: the value is empty, holds a `/` or a `\`, or is `.` or `..`.
  - `has leading or trailing whitespace`: trim the value.
- **The hooks are wired but print nothing.** Shadow mode is on (`doctor` shows `shadow ON`). Run
  `config set shadow false --write`.
- **A harness looks wired but never shows in `doctor`'s last-seen column.** It is not running the hooks. For Codex,
  start it interactively once and trust the new hooks.
- **A decision check never runs.** `doctor` warns "A decision check is on, but no Stop hook of ours is wired". Run
  `tools agents hooks install --write`: the Stop entry is written only while a check that needs it is on.
- **`uninstall` did not stop the hooks.** Hook config is snapshotted at session start; it takes effect in the next
  session. Use `AGENTS_HOOKS_DISABLE=1` for the running one.
- **Claude Code shows its own Bash diff and the hook's diff.** `CLAUDE_CODE_BASH_EDIT_DIFF=1` is set in that session's
  environment. `doctor` and `native-diff status` warn about it.
- **A diff message says "Output too large".** The message passed 10,000 characters. Lower `diff.maxMessageChars`, or
  read the full diff with `hooks diff show <call>`.
- **The diff is silent on a file that changed.** Check `hooks diff log --extended` for the call: it says what the hook
  decided and why (another session's change, a temp file, a `log` or `generated` category).
- **A custom rule does not fire.** `doctor` lists modules that failed to import, took over 3 s, or reused an id;
  `rules test '<command>'` shows each layer of the outcome.
- **`changes` answers an empty list.** Check the session id: a prefix is completed from the history index, and an
  ambiguous one is refused with the candidates.
- **A blame or `changes --diff` shows `missing-blob`.** The row is older than the 30 days the object store keeps.

## Agent turn state: working, waiting, or stalled?

`src/utils/ai/transcripts/activity.ts` decides which of four states an agent is in, from events each harness dialect
writes (`src/utils/agent-sessions/readers/<harness>-turn-state.ts`). The one door from a transcript path to that state
is `readTurnState` (`src/utils/ai/transcripts/turn-state.ts`); the dialog guard, `tools ai agent wait`, the live tail,
cmux and the hub's Codex sub-agent status (`src/hub/lib/agents/codex-agents.ts`) all read it.

| State | Meaning |
|---|---|
| `FINISHED` | An exit event, the process is gone, or the transcript is closed (a `.jsonl.zst` rollout). |
| `AWAITING-INPUT` | The newest turn ended, or it waits on a question tool. A prompt is never a stall. |
| `STALLED` | Silent for longer than `stallTimeoutMs` (the newer of the last event and the file's mtime). |
| `RUNNING` | Anything else. |

```ts
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";

// One stat and one 256 KB read of the end of the file (plus the event log for a harness that has one).
const snapshot = readTurnState("claude", transcriptPath, { stallTimeoutMs: 120_000 });
// { state: "STALLED", turnEnded: false, lastActivityAt: 1760000000000, silenceMs: 241000, ... }, or null
```

Two limits are worth knowing. Records after the last conversation record (`cost-state`, `system`, `queue-operation`)
say nothing about the state, so they are skipped: 39 of the 40 most recent transcripts on one machine ended on one
(2026-10-05), and the old rule that read the final line labelled 39 of them `STALLED` and none `AWAITING-INPUT`. And
`listSubagents` (`src/utils/ai/transcripts/subagents.ts`) answers a nearby question for sub-agents with a fixed
15-minute limit and no waiting state; the two are not merged.

## Development

| Path | What |
|---|---|
| `src/agents/commands/` | The command registrars (`hooks.ts`, `hooks-rules.ts`, the per-harness installers). |
| `src/agents/lib/` | The bus: feed, slots, cursors, session resolution, formats. |
| `src/utils/shell/scan.ts` | Tokenises a command into a `ShellScan`; no imports at all. |
| `src/utils/shell/rules/*` | The 23 built-in shell rules, one file per family, plus the registry. |
| `src/agents/lib/hooks/tool-rules.ts` | The 4 rules about GenesisTools' own commands. |
| `src/agents/lib/hooks/custom-rules.ts` | Loads `guard.customRules` modules, crash-safe. |
| `src/agents/lib/hooks/codex.ts` | Codex `hooks.json` install, uninstall and trust status. |
| `src/agents/lib/hooks/sections/` | One file per config section: defaults, merge, `set` keys, entries, doctor rows. |
| `src/agents/lib/hooks/*` | Config, outcome ladder, payload parsing, guard, log, state, gc, install. |
| `src/agents/lib/hooks/diff/*` | Capture, collect, attribution, before-copy, render, post-phase orchestration. |
| `src/agents/lib/changes/` | The change log, `changes` and `blame`. |
| `src/agents/bin/hook-pre.ts` | PreToolUse: guard then capture, in one process. |
| `src/agents/bin/hook-guard.ts`, `hook-diff-pre.ts` | Each half alone, for a harness that wants one, and the benchmark. |
| `src/agents/bin/hook-diff-post.ts` | PostToolUse and PostToolUseFailure: the diff and the change log. |
| `src/agents/bin/hook-session-end.ts` | SessionEnd: sweep this session's captures, then stale ones. |
| `src/agents/bin/hook-stop.ts`, `hook-prompt.ts` | Stop and UserPromptSubmit. |
| `src/agents/bin/hook-question.ts` | The questions feature (loads `questions.ts` only with work). |
| `src/agents/lib/hooks/questions.ts` | What a hook payload does to the dialog records (`questionHookAction`), and applying it. |
| `src/agents/bin/hook-subagent-line.ts` | Claude Code's `subagentStatusLine` command (`mods.agentRow`). |

The bus and the hooks are built on shared helpers:

- `@genesiscz/utils/storage` (`withFileLock`) and `@genesiscz/utils/storage/storage` (`atomicWriteFileSync`).
- `@genesiscz/utils/storage/stale-lock-sweep`: a generic stale-PID lock reaper. It tells a dead or reused PID through
  `classifyPid` from `@genesiscz/utils/process-identity`.
- `@genesiscz/utils/log-session/jsonl-reader` (line-safe JSONL) and `@genesiscz/utils/json` (`SafeJSON`, never `JSON`).
- `@genesiscz/utils/env` (`env`, for example `env.agents.areHooksDisabled()` behind `AGENTS_HOOKS_DISABLE`).
- `@genesiscz/utils/cli` (`runTool`, `suggestCommand`, `isInteractive`).

### Proving a change

```bash
bun run typecheck
bun run test src/agents/ src/utils/shell/ src/utils/git/
tools agents hooks rules check --corpus 3000   # every rule's examples, then a replay of real commands
bun scripts/benchmarks/hooks/hook-latency.ts [--custom-rules <folder>]
tools agents login --agent-main --agent-name lead --once --timeout 5 --session demo
tools agents discover --session demo
```

The parity harnesses that compared this port with the older guard it replaced (`scripts/hooks-parity.ts`,
`hooks-diff-parity.ts`, `hooks-config-parity.ts`, `hooks-shadow-report.ts`) were retired on 2026-10-12 together with
that guard. Their last run: 3000 commands with 0 mismatches, 224 config resolutions with 0 mismatches, and 12 diff
scenarios with 0 mismatches (1 expected divergence: the old hook went silent on a C-quoted path).

## Related

- [`tools question`](../question/README.md): the decision log, the inbox, `question_post` and staleness alerts.
- [`tools codex`](../codex/README.md) and [`tools grok`](../grok/README.md): workers that join a swarm through
  `GT_RENDEZVOUS_SESSION`.
- [`tools claude`](../claude/README.md): `tools claude message` reaches a session off the bus; `tools claude start`.
- [`tools hub`](../hub/README.md): the inbox that lists open questions and the "Last N turns" changes.
- [`tools compress`](../compress/README.md): the daily pass that packs the object store.
- [`tools rm`](../rm/README.md): the deletion tool the GenesisTools guard rules point at.
- [`tools link`](../link/README.md): the `tsconfig.json` that custom rules outside this repository import through.
- [`tools genesis-tools`](../genesis-tools/README.md): `probe`, which decides which links the mods write.

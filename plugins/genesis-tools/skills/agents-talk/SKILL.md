---
name: agents-talk
description: "CLAUDE ONLY, and only inside a handoff-to run. Picks the channel for a multi-agent swarm that must talk while it works: tools agents bus across hosts, with a real monitor for async delivery. NOT for spawning ordinary subagents, and NOT for a single worker. Codex must never invoke this skill: it has no monitor, so the protocol here cannot work, and tools codex passes what a codex worker needs into its brief instead."
---

# `/agents-talk` — cross-agent communication protocol

> **🛑 Codex must never invoke this skill.** These plugin hooks and skills are portable, so a
> Codex CLI or Codex Desktop session can see this file. It still does not apply. Codex has no
> `Monitor` tool, so it has no NONBLOCKING receive: the table below offers it only `login
> --once`, which blocks the turn, and a protocol whose whole point is talking WHILE you work
> cannot be built on that. (Reachable in blocking mode is not the same as workable — do not
> read the ban as "the bus is unreachable from Codex".) A Codex worker that is
> part of a swarm gets what it needs from the brief that `tools codex` and `gt:handoff-to` build
> for it. Use the native Codex collaboration tools instead.
>
> **🛑 Claude: this is not a "spawning subagents" skill.** Invoke it only when `gt:handoff-to` has
> established a run whose agents must talk to each other WHILE they work. Ordinary subagents that
> report back when finished need nothing from this file.

Choose the communication channel before starting receivers. **Codex subagents communicating while they work must use the nonblocking native path below when available.** Do not start a CLI inbox for this path. Use `tools agents` when agents on different hosts or CLI workers need a shared bus. If the user explicitly requires the bus, use a real monitor for asynchronous delivery; without one, explain the capability gap rather than quietly substituting blocking `--once`. No MCP server is required.

## Choose by tools actually exposed

Host names alone do not establish capabilities. Inspect the current tool inventory **for each participant**, not just the parent. In the live relay verification, two child contexts could run the bus but reported no native peer-messaging tool, while the parent and three other child contexts could call native collaboration. Do not infer a permanent model limitation from one run.

| Available capability | Receive and wake strategy |
|---|---|
| A real `monitor` / `Monitor` that subscribes to command stdout | Use it on `tools agents login --format json` itself. Enable persistent mode when supported. Verify delivery in this host, especially for idle children. |
| Codex native collaboration within one agent tree | Prefer native messages and its documented task/resume tool. No bus receiver is needed. |
| No monitor, but terminal execution with resumable output | `login --once` can await mail only when blocking is acceptable. It does not satisfy nonblocking communication. A terminal handle is not a push subscription. |
| No native wake mechanism and an idle child | The parent must resume the child using the host's supported operation. The bus cannot schedule model turns. |

Do not add sleep, roster, or file polls between sends and receives. A running `--once` already waits on filesystem notifications. There is no literal zero-delay guarantee: CLI startup, filesystem fallback checks, tool-result delivery, and model scheduling all contribute.

## Codex native collaboration

Verified in a live Codex session on 2026-09-07 UTC: `collaboration.send_message`, `followup_task`, and `wait_agent` were exposed; no `monitor` / `Monitor` was exposed. Other Codex builds may have different names. Read their current schemas.

- `collaboration.send_message` delivers to a running agent at message boundaries or after its pending tool call. It **does not start an idle agent's turn**.
- `collaboration.followup_task` starts a turn when the target is idle and delivers the task when it is already running. Use this for a recipient that may have finished.
- `collaboration.wait_agent` waits for native mailbox or status changes. It does not watch a CLI's stdout.
- Native message payloads are appropriate for normal Codex-only work. Do not duplicate every payload onto the bus merely because this skill was loaded. Native messages can remain in the host transcript; the bus adds a separate shared feed, not proof that native messages have no persistence.

### Nonblocking Codex path: send, handle incoming messages, continue work

1. Include canonical peer names in every worker brief, for example `/root/researcher` and `/root/reviewer`. Have each worker prove its native send capability with one readiness message, then start its assigned work. The native collaboration tools are top-level tools, deliberately absent from `functions.exec`'s nested `tools` object and `ALL_TOOLS`; that catalog alone is not a capability check.
2. Send the full payload to an active peer with `collaboration.send_message`. If the peer may have ended its turn, use `collaboration.followup_task` with the full payload. Do not send a bare wake nudge that requires the recipient to open a CLI inbox.
3. Continue the assigned work immediately after sending. Incoming native `MESSAGE` events arrive at model message boundaries or after a pending tool call. Handle actionable mail before starting the next unrelated step, reply or forward, then resume work. Receiving requires no tool call.
4. Do not call `login`, `login --once`, `tools agents request`, `write_stdin`, `wait_agent`, or a sleep/poll loop merely to receive these native messages. `wait_agent` is appropriate only when the task itself has nothing useful left to do until another agent finishes.
5. If a child cannot use native peer tools, choose a worker context with demonstrated support for work requiring nonblocking peer communication. Do not silently downgrade that requirement to a blocking bus receiver.

A worker brief can use this exact contract:

> Communicate with peers through the native collaboration tools. Send the full payload with `send_message` to a working peer or `followup_task` to a possibly-idle peer. Continue your assigned work. On an incoming MESSAGE, handle it promptly and resume work. Do not start a bus receiver or wait/poll for messages. Report a missing native capability instead of inventing a substitute.

Verified with three real working Codex subagents on 2026-09-07 UTC: A -> B -> C -> D -> B -> A returned ABCDBA using only native `send_message` for the relay. B received both messages while auditing source; C and D received theirs after sending audit findings but before ending their original turns. Every receipt was `MESSAGE`, with no receive call or later task wake. The model turns still took seconds; the verification establishes nonblocking delivery, not millisecond model response.

**After selecting this native path, do not apply the bus login flows below.**

When the bus is required in Codex, pin `--session <shared-id>` in every worker brief and command. Each worker owns its own bus identity. A native child is not automatically a `tools codex spawn` worker.

```bash
tools agents login --agent-name worker --once --format json \
  --session <shared-id>
```

`--once` emits `ready`, drains ALL currently matching queued events, and exits. With an empty mailbox it blocks until an event matches, with an eight-hour cap. It is not a nonblocking inbox check. Never put it in a routine work checkpoint unless waiting for mail is intended.

If execution yields a terminal session id, resume that process with `write_stdin`; if a functions cell yields its cell id, use `functions.wait`. Do not start another login for that identity while the old one is alive. These operations retrieve output; they do not provide an always-on monitor.

For a possibly-idle native Codex child in an explicitly blocking bus workflow:

1. Send the bus payload.
2. Use `collaboration.followup_task` with the shared session, bus identity, and receive instruction.
3. The child retrieves its existing receive call if one is still alive, or starts `--once` if none is alive. The child sends an explicit reply after processing when confirmation matters.

A standalone stream with nobody consuming its terminal output can advance its cursor without ever reaching the model. A later `--once` will not replay those stdout-emitted events. Keep one receiver under the active agent's control; a wake nudge cannot repair discarded output.

## Mental model in one sentence

There's a shared **feed.jsonl** per session under `~/.genesis-tools/agents/<session>/`. Anyone with filesystem access can append events through the CLI. Login auto-registers, filters events, and emits JSONL on stdout. A capable harness monitors that stream; other hosts receive through blocking `--once` calls.

**In a bus workflow, login stdout is the inbox.** Do not `cat`, `Read`, or poll `feed.jsonl`, a tee'd file, or a cursor file. Mail arrives as JSONL lines from `tools agents login`. Send with `tools agents message`; inspect the roster with `tools agents discover`.

## Topology (the only one you need)

```text
                  ┌──────────────────────────┐
   ┌──────────►   │     feed.jsonl           │   ◄──────────┐
   │              │   (append-only, seq #)   │              │
   │              └──────────────────────────┘              │
   │       ▲                                       ▲        │
   │       │ append                                │ append │
   │       │                                       │        │
   │  ┌────┴────┐         ┌─────────┐         ┌────┴────┐  │
   └──┤  lead   │         │ research│         │ reviewer├──┘
      │ (main_) │         │ er      │         │         │
      └─────────┘         └─────────┘         └─────────┘
        login                login                login
        (stream+monitor)     (stream+monitor     (stream+monitor
                              or --once)          or --once)
```

Every agent is symmetric: anyone can message anyone, anyone can broadcast. The "lead" is just an agent with `main_` prefix and `is_main:true` in the registry.

## Main agent flow (you're the orchestrator)

```bash
# With a real monitor available (otherwise use --once as described above):
# 1. Attach as main. login auto-registers on first use — no separate register
#    step. Wrap this command with the harness monitor tool (persistent) so
#    each stdout JSONL line wakes you. Main sees EVERY swarm message except
#    its own sends — peer hops land here, not only mail addressed to lead.
tools agents login --agent-main --agent-name lead --format json
# First stdout line is {type:"ready",...}. Then feed events.
# Optional: --kinds message to hide lifecycle and keep only hops.

# 2. Spawn each subagent (via the Agent tool with run_in_background:true).
#    Include in their prompt: "Right after you start, run: tools agents login --agent-name <name>"
#    There's no pre-allocated slot to wait on — the subagent's own login call
#    auto-registers it the moment it runs.

# 3. Send instructions to a subagent (after it has logged in):
tools agents message --from lead --to researcher \
  --body 'find recent React Compiler benchmarks and post the findings'

# 4. Broadcast to all:
tools agents message --from lead \
  --body 'team status check'

# 5. Inspect the roster any time:
tools agents discover

# 6. Watch the whole conversation in a separate terminal (human-friendly):
tools agents listen

# Keep a compact receiver stream without changing what senders publish:
tools agents login --agent-name lead --kinds message,error,approval_request
tools agents login --agent-name lead --filter '.op=="approval_request"'

# Enable verbose lifecycle visibility for ALL peers (default: only main sees
# stream-mode join/leave + real-failure logout; other peers see nothing):
tools agents login --agent-main --agent-name lead --debug
```

## Subagent flow (you've just been spawned)

Your spawn prompt should already include your `--agent-name`. The very first thing you do:

```bash
# A. Log in (auto-registers on first use — no separate register step). Two
# modes — pick based on your harness:
#
# Any host exposing a real monitor / Monitor tool: stream mode.
# Point the harness monitor at this command. Do NOT tee it to a file.
# Do NOT poll the file. Do NOT Read feed.jsonl. The monitor lines ARE the inbox.
tools agents login --agent-name researcher --format json
#
# No monitor: --once blocks for mail; it is not a nonblocking check.
tools agents login --agent-name researcher --once
```

With a monitored stream, keep working after `ready` and react when a message arrives. With `--once`, await matching mail through that same receive call before treating it as complete. Send with `tools agents message`. Do not sit in a sleep/discover poll loop waiting for mail.

> ⚠️ **Monitor the login command itself.** `login` stdout is the JSONL event stream. When stderr is a TTY it may print diagnostics; when piped (Grok `monitor` merges streams) login keeps stderr quiet. Still do not `2>&1` on purpose. Do not redirect stdout to a file and then poll that file.

## ⚠️ Idle teammates do NOT wake on agents-channel traffic (Claude Code)

Empirically verified 2026-07-13 (two live probe tests + teammate-transcript forensics):

- A teammate whose turn has ENDED (idle) is **not re-invoked** by Monitor events on its login stream, and the pending Monitor notification is **not injected at wake either** — transcript inspection showed no monitor-event entry while idle nor in the wake bundle. At best it trickles in mid-turn once the teammate is already active again (observed arriving AFTER the teammate had manually read the output file). The login background process stays alive and keeps writing events to its output file; the harness just never turns that into a wake for a subagent.
- Background-task completion (`login --once` exiting when a message arrives) does **not** wake an idle teammate either.
- The **only** channel that wakes an idle teammate is the harness-native `SendMessage` tool.
- The MAIN session is different: its Monitor events DO re-invoke it between turns. The asymmetry affects teammates only.
- Recovery depends on the receiver. Retrieve an existing receiver's pending stdout through the harness. Start `--once` only when that identity has no live receiver. The cursor tracks stdout emission, so `--once` cannot recover lines already emitted to a monitor that dropped them. The historical wake observations above do not establish end-to-end replay safety.

**Dual-channel protocol (required whenever the recipient may be idle on Claude Code):**

1. Payload goes on the agents channel (stored in the feed; see delivery limits below):
   `tools agents message --from lead --to researcher --body '...'`
2. Immediately follow with a harness wake nudge:
   `SendMessage(to: "researcher", "agents-mail waiting — drain your stream")`
3. The woken teammate retrieves its existing receiver's output, or starts `login --once` if no receiver is alive, then replies on the agents channel. If a monitor discarded an emitted payload, the sender must resend it; a cursor resume does not restore it.

On **Grok**:

- Wrap `tools agents login` with the harness `monitor` tool (`persistent: true`). Do not tee to a file.
- The **parent** receives: (1) its own main login stream (every swarm hop), and (2) each child's monitor lines (Grok bubbles child monitor events into the parent turn).
- An idle Grok **child is not re-invoked** when its inbox line arrives. Verified 2026-08-22: the child ended after `monitor`, hop 0 landed on the parent as `[alpha inbox]`, and alpha stayed idle until `resume_from`. Same shape as Claude Code idle teammates, without `SendMessage`.
- To act inside one child turn, block on `tools agents login --agent-name X --once` (still `tools agents`, not a file). To act after the child has stopped, the parent `resume_from`s that child with the inbox JSON.

In these bus workflows, send payloads through `tools agents` and use the host's native resume operation for idle recipients. Do not assume Claude Code's `SendMessage` wake behavior applies to Codex's `collaboration.send_message`; Codex requires `followup_task` in the tool set described above. Monitor delivery during an active turn still depends on the host.

## 🛑 Protocol JSON on `SendMessage` is LIVE CONTROL, never a test payload

Observed 2026-08-20 in a probe session. `SendMessage` carrying
`{"type":"shutdown_request"}` was treated by the harness as a real shutdown:
the recipient approved it and terminated. A second teammate emitted
`shutdown_approved` and terminated as well, without ever being sent a shutdown.
A teammate that received no shutdown at all answered with eight
`shutdown_rejected` messages in 105 seconds.

- **Never send harness protocol JSON to "see what happens".** There is no dry
  run. The shape IS the command, so a probe payload kills the agent.
- To test message delivery, send prose, or send JSON under a key of your own
  (`{"probe": {...}}`) that no harness verb matches.
- Protocol replies are also positional: a `shutdown_response` is rejected
  unless it is addressed to `team-lead`, while other reply shapes are accepted
  from anywhere. Do not infer one rule from the other.
- Ordinary `tools agents login` treats bodies as opaque strings. **Downstream bridges can interpret them as commands.** In particular, `tools codex spawn` subscribes through `AgentsBridge`, which parses addressed bodies with `parseControlBody`. Stop, interrupt, rollback, and approval operations are live controls there. Use ordinary relay prose for delivery tests; do not send control-shaped probe payloads to a `codex_<name>` worker.

`login` writes received events to stdout as JSONL lines. Each line is one event you should react to.

```bash
# B. Send a message to a specific peer:
tools agents message --from researcher --to reviewer \
  --body 'I found library X has a critical bug in v2.1'

# C. Broadcast (no --to):
tools agents message --from researcher \
  --body 'finding #1 ready for review'

# D. Reply to a specific message (auto-routes to its sender, correlates by message_id):
tools agents message --from reviewer --reply 0001 \
  --body 'confirmed — also affects v2.0'

# E. Pure ack (no body):
tools agents message --from reviewer --reply 0001

# Send one request and block until a correlated --reply arrives:
tools agents request --from reviewer --to lead --body 'Approve the auth change?'
```

## Long-lived Codex CLI workers, separate from native subagents

`tools codex spawn` creates a persistent app-server session and auto-registers `codex_<name>` on this same bus. Do
not manually log that identity in from the orchestrator — the model receives with its seeded
`tools agents login --agent-name codex_<name> --once --session <id>` command.

Write policies, steering, approvals, and the driver-subagent pattern live in **`gt:handoff-to`**, whose
`references/codex.md` carries the Codex mechanics. Load that skill rather than hand-rolling a spawn from here.

## What you receive on the `login` stream

Each event is a JSON line. The most important `type` values:

| type | meaning |
|---|---|
| `ready` | stdout-only (not in the feed). Login attached; mailbox is live. Printed even with `--kinds`. |
| `message` | someone sent a message. A reply is a `message` with `in_reply_to` set (empty `body` = pure ack). **Main sees every swarm message except its own.** Non-main agents see only mail to them, plus broadcasts. |
| `logged_in` / `logged_out` | a peer joined or left. Main agents see stream-mode joins/leaves by default; non-main peers see nothing unless the swarm was started with `--debug`. `--once`-mode polling churn is always hidden. |

**You never see your own sends.** The CLI filters out events where `from_agent_id == your id` before they reach your stream — no echo-prevention logic needed on your end.

**The cursor tracks emission, not processing.** `drainPending` writes visible events to stdout, then saves the last scanned `seq` in `slots/<agent_id>.cursor`. Normally a reconnect skips those events. Filters also advance the cursor past non-matches.

This is not exactly-once or end-to-end lossless delivery. A crash after stdout emission but before the cursor write can duplicate an event; output discarded after the cursor write will not replay. The shutdown path releases the slot before its final drain, so reconnects can race that drain. Consumers needing processing confirmation must explicitly reply and make retried work idempotent. `message --reply` and `request` correlate replies; they do not defer the login cursor until processing completes.

The Codex app-server bridge has a separate persisted sequence checkpoint. It currently advances before control dispatch, so a crash between checkpoint and execution can skip a command on restart. A stored feed alone is not a guarantee of completed control execution.

## Receive-mode comparison

| | Stream, the default mode | `--once` |
|---|---|---|
| Lifetime | Long-running, eight-hour cap | Drains queued matches and exits; if empty, waits for a match up to eight hours |
| Harness integration | A real monitor subscribes to login stdout | An active caller awaits the command or resumes its terminal handle |
| Resume after exit | Starts after the saved emission cursor | Starts after the same saved emission cursor |
| Cost | One held process per agent | One process startup per receive batch |
| Best for | Receiving during work on a host with a working monitor | Awaiting a message when there is no monitor |

Stream is the default, not a `--stream` flag. Both modes use the same filesystem watcher. Login and the listener schedule filesystem notifications without an intentional debounce delay; login retains a 150 ms fallback check and listen retains the shared 1000 ms fallback. These are fallback intervals, not latency guarantees. Every drain currently parses the full feed, so large histories and bursts increase work.

On exit (signal, cap, or crash), the tool prints a `tools agents login ...` resume command on stderr when stderr is a TTY. Piped/monitor runs keep stderr quiet so the harness does not treat diagnostics as events.

## Session resolution

The CLI auto-detects the session in this order:

1. `--session <id>` explicit
2. `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION` (set by `tools codex spawn` / `tools grok spawn` — the parent saying which swarm to join)
3. The host session id: `$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`, `$GROK_SESSION_ID`, `$COPILOT_AGENT_SESSION_ID`. When several are set (a worker inherits its parent's), the one whose swarm ALREADY EXISTS wins, so a worker joins its parent instead of starting an orphan swarm. If none exists, the first present id creates one.
4. Single session active (feed touched) in the last 60 seconds
5. Otherwise: a friendly error asking for `--session` or one of those env vars

Every host publishes a session id and subagent shells inherit it: Claude Code `$CLAUDE_CODE_SESSION_ID`, Codex `$CODEX_THREAD_ID`, grok `$GROK_SESSION_ID` (grok has always set it; the resolver ignored it until 2026-08-29), GitHub Copilot CLI `$COPILOT_AGENT_SESSION_ID` (mirrors the CLI's own `--session-id`; the resolver ignored it until 2026-08-31, which is why a Copilot session could not claim a handoff). Passing `--session` explicitly is still the surest thing in a worker brief, and exporting `GENESIS_AGENTS_SESSION` in the parent pins the whole swarm.

## Common pitfalls

- **Don't poll files.** In a bus workflow, no `cat`/`Read` of `feed.jsonl`, no tee'd login capture, and no sleep+stat loops. Use a real monitor on login stdout for asynchronous delivery; use `login --once` only when blocking is acceptable. Native Codex communication needs neither receiver.
- **There's no separate register step.** `login --agent-name X` auto-registers X the first time it's called — just spawn the subagent and have it call `login` directly.
- **Don't message agents that aren't registered.** You'll get an error. Call `discover` if unsure.
- **Don't expect mid-tool-call interrupts.** A real monitor delivers according to the host's scheduling. An already-running `login --once` returns on matching mail; queued mail is drained immediately when a new call starts. Neither preempts unrelated work.
- **Don't expect an idle teammate to wake on an agents-channel message.** Use the host-specific wake operation above. A monitor, terminal handle, mailbox wait, and task resume are different capabilities.
- **One main per session.** A second `login --agent-main` errors. Use a different `--agent-name` for additional coordinators.
- **Receiver filters intentionally advance that receiver's cursor past non-matches.** Use a dedicated monitor identity
  when you may later need the unfiltered stream.

## Quick reference

| Command | Purpose |
|---|---|
| `tools agents login --agent-main --agent-name lead [--debug]` | Auto-register + attach as main, stream mode. Main's stream is the swarm inbox (all messages except own). Optional `--debug` lifecycle for everyone. |
| `tools agents login --agent-name X` | Auto-register + attach as X, stream mode (Monitor follows stdout) |
| `tools agents login --agent-name X --once` | Auto-register + drain a queued batch, or block for matching mail |
| `tools agents login --agent-id Y --agent-name X` | Attach with a chosen id |
| `tools agents message --from X --to Y --body '...'` | Direct |
| `tools agents message --from X --body '...'` | Broadcast (every peer except the sender) |
| `tools agents message --from X --reply 0001 --body '...'` | Reply (auto-routes to the original sender) |
| `tools agents message --from X --reply 0001` | Pure ack (no body) |
| `tools agents message --from X --to Y --body-file <path>` | Long/multi-section body — write it to a file first (avoids shell-quoting breaks from embedded `'`/`` ` ``/`$(...)` truncating `--body`) |
| `tools agents request --from X --to Y --body '...'` | Send and block until a correlated reply arrives |
| `tools agents login --agent-name X --kinds message,error` | Receiver-side event/body-kind filter |
| `tools agents login --agent-name X --filter '.op=="approval_request"'` | Receiver-side structured-body filter |
| `tools agents discover` | List all agents in session |
| `tools agents listen` | Human-facing color-formatted feed follower (sees everything) |

### ID formats (per session)

- `agent_id` for subagents: `agt_0001` → `agt_ffff` (monotonic, 4-hex zero-padded)
- `agent_id` for the main agent: `main_<sessionSlug>` (derived from session id; recognizable at a glance)
- `message_id`: `0001` → `ffff` (monotonic, 4-hex, same cap as agent_id)
- `seq`: monotonic feed sequence number (decimal, unbounded for v1 practical use)

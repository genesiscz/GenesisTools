---
name: agents-talk
description: Cross-agent messaging protocol via `tools agents`. Use when the main agent is about to spawn subagents that should be able to message each other (or back to the main agent) during their work. Teaches the login (auto-registers) / message / discover / listen pattern, the stream-vs-once receive modes, and the no-loss delivery contract.
---

# `/agents-talk` — cross-agent communication protocol

You're about to spawn (or have just been spawned as) one of N agents that need to exchange messages while they work. This skill teaches how. **All communication goes through `tools agents`.** No MCP server is required.

## Mental model in one sentence

There's a shared **feed.jsonl** per session under `~/.genesis-tools/agents/<session>/`. Anyone can append events (login auto-registers, message). Each agent runs a long-lived `login` process that tails the feed, filters lines, and emits them as JSONL on stdout — which the harness `monitor` / `Monitor` tool follows.

**The login stdout stream is the only inbox.** Do not `cat`, `Read`, or poll `feed.jsonl`, a tee'd file, or a cursor file. Mail arrives as JSONL lines from `tools agents login`. Send with `tools agents message`. Roster with `tools agents discover`. That is the whole `tools agents *` surface.

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
# Grok / Claude Code (you have a monitor / Monitor tool): stream mode.
# Point the harness monitor at this command. Do NOT tee it to a file.
# Do NOT poll the file. Do NOT Read feed.jsonl. The monitor lines ARE the inbox.
tools agents login --agent-name researcher --format json
#
# Other hosts (no monitor tool): --once. That is still `tools agents`, not a file.
tools agents login --agent-name researcher --once
```

After `ready`, keep working. When a monitor line with `"type":"message"` arrives, send with `tools agents message` and continue. Do not sit in a sleep/discover poll loop waiting for mail.

> ⚠️ **Monitor the login command itself.** `login` stdout is the JSONL event stream. When stderr is a TTY it may print diagnostics; when piped (Grok `monitor` merges streams) login keeps stderr quiet. Still do not `2>&1` on purpose. Do not redirect stdout to a file and then poll that file.

## ⚠️ Idle teammates do NOT wake on agents-channel traffic (Claude Code)

Empirically verified 2026-07-13 (two live probe tests + teammate-transcript forensics):

- A teammate whose turn has ENDED (idle) is **not re-invoked** by Monitor events on its login stream, and the pending Monitor notification is **not injected at wake either** — transcript inspection showed no monitor-event entry while idle nor in the wake bundle. At best it trickles in mid-turn once the teammate is already active again (observed arriving AFTER the teammate had manually read the output file). The login background process stays alive and keeps writing events to its output file; the harness just never turns that into a wake for a subagent.
- Background-task completion (`login --once` exiting when a message arrives) does **not** wake an idle teammate either.
- The **only** channel that wakes an idle teammate is the harness-native `SendMessage` tool.
- The MAIN session is different: its Monitor events DO re-invoke it between turns. The asymmetry affects teammates only.
- Consequence for the woken teammate: drain with `tools agents login --agent-name <me> --once` (still `tools agents`, not a file read). Missed monitor notifications are not replayed into context; `--once` reads the cursor.

**Dual-channel protocol (required whenever the recipient may be idle on Claude Code):**

1. Payload goes on the agents channel (durable, cursor-tracked, no loss):
   `tools agents message --from lead --to researcher --body '...'`
2. Immediately follow with a harness wake nudge:
   `SendMessage(to: "researcher", "agents-mail waiting — drain your stream")`
3. The woken teammate drains with `tools agents login --agent-name researcher --once`, then replies on the agents channel. (Do not wait for the Monitor notification: it was dropped, not queued.)

On **Grok**:

- Wrap `tools agents login` with the harness `monitor` tool (`persistent: true`). Do not tee to a file.
- The **parent** receives: (1) its own main login stream (every swarm hop), and (2) each child's monitor lines (Grok bubbles child monitor events into the parent turn).
- An idle Grok **child is not re-invoked** when its inbox line arrives. Verified 2026-08-22: the child ended after `monitor`, hop 0 landed on the parent as `[alpha inbox]`, and alpha stayed idle until `resume_from`. Same shape as Claude Code idle teammates, without `SendMessage`.
- To act inside one child turn, block on `tools agents login --agent-name X --once` (still `tools agents`, not a file). To act after the child has stopped, the parent `resume_from`s that child with the inbox JSON.

Never put the payload only in `SendMessage` (not durable, not cursor-tracked) and never rely on the agents channel alone to wake an idle teammate. A teammate that is mid-turn WILL receive Monitor events normally between tool calls — the nudge is only load-bearing for idle recipients, but since the sender can't know, always send it.

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
- This concerns the harness `SendMessage` tool only. **`tools agents` never
  does this**: `message`/`request` bodies are opaque strings, the receiver only
  prints them (`src/agents/lib/filter.ts`), and shutdown is triggered solely by
  OS signals (`src/agents/lib/lifecycle.ts`). Nothing you put in an agents-channel
  body can terminate a peer.

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

## Long-lived Codex teammates

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

**The tool dedupes for you.** Delivery uses a monotonic per-agent cursor (`slots/<agent_id>.cursor`), not a content hash — a crashed-and-reconnected receive process resumes from its last-acked `seq` instead of re-emitting already-seen events.

## Receive-mode comparison

| | `--stream` (default, CC) | `--once` (any host) |
|---|---|---|
| Lifetime | Long-running, ~8h sanity cap | Returns when a message arrives or harness kills it |
| Harness tool | `Monitor` follows stdout | Caller re-invokes in a loop |
| Resume after exit | Continues where it left off | Continues where it left off |
| Cost | One held process per agent | One short-lived call per receive |
| Best for | Always-on receive during a task | Polling pattern when Monitor isn't available |

On exit (signal, cap, or crash), the tool prints a `tools agents login ...` resume command on stderr when stderr is a TTY. Piped/monitor runs keep stderr quiet so the harness does not treat diagnostics as events.

## Session resolution

The CLI auto-detects the session in this order:

1. `--session <id>` explicit
2. `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION` (set by `tools codex spawn` / `tools grok run` — the parent saying which swarm to join)
3. The host session id: `$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`, `$GROK_SESSION_ID`. When several are set (a worker inherits its parent's), the one whose swarm ALREADY EXISTS wins, so a worker joins its parent instead of starting an orphan swarm. If none exists, the first present id creates one.
4. Single session active (feed touched) in the last 60 seconds
5. Otherwise: a friendly error asking for `--session` or one of those env vars

Every host publishes a session id and subagent shells inherit it: Claude Code `$CLAUDE_CODE_SESSION_ID`, Codex `$CODEX_THREAD_ID`, grok `$GROK_SESSION_ID` (grok has always set it; the resolver ignored it until 2026-08-29). Passing `--session` explicitly is still the surest thing in a worker brief, and exporting `GENESIS_AGENTS_SESSION` in the parent pins the whole swarm.

## Common pitfalls

- **Don't poll files.** No `cat`/`Read` of `feed.jsonl`, no tee'd login capture, no sleep+stat loops. Use `tools agents login` (stream + harness monitor) or `login --once`. The tool handles cursors, dedup, and filtering.
- **There's no separate register step.** `login --agent-name X` auto-registers X the first time it's called — just spawn the subagent and have it call `login` directly.
- **Don't message agents that aren't registered.** You'll get an error. Call `discover` if unsure.
- **Don't expect mid-tool-call interrupts.** Stream-mode `login` delivers between tool calls (via Monitor), `login --once` returns when next called. Neither preempts a running tool.
- **Don't expect an idle teammate to wake on an agents-channel message.** See the idle-teammates section above — pair every send to a possibly-idle teammate with a harness `SendMessage` nudge.
- **One main per session.** A second `login --agent-main` errors. Use a different `--agent-name` for additional coordinators.
- **Receiver filters intentionally advance that receiver's cursor past non-matches.** Use a dedicated monitor identity
  when you may later need the unfiltered stream.

## Quick reference

| Command | Purpose |
|---|---|
| `tools agents login --agent-main --agent-name lead [--debug]` | Auto-register + attach as main, stream mode. Main's stream is the swarm inbox (all messages except own). Optional `--debug` lifecycle for everyone. |
| `tools agents login --agent-name X` | Auto-register + attach as X, stream mode (Monitor follows stdout) |
| `tools agents login --agent-name X --once` | Auto-register + attach, one-shot mode (poll loop) |
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

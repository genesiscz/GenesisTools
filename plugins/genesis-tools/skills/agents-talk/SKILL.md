---
name: agents-talk
description: Cross-agent messaging protocol via `tools agents`. Use when the main agent is about to spawn subagents that should be able to message each other (or back to the main agent) during their work. Teaches the login (auto-registers) / message / discover / listen pattern, the stream-vs-once receive modes, and the no-loss delivery contract.
---

# `/agents-talk` — cross-agent communication protocol

You're about to spawn (or have just been spawned as) one of N agents that need to exchange messages while they work. This skill teaches how. **All communication goes through `tools agents`.** No MCP server is required.

## Mental model in one sentence

There's a shared **feed.jsonl** per session under `~/.genesis-tools/agents/<session>/`. Anyone can append events (login auto-registers, message). Each agent runs a long-lived `login` process that tails the feed, filters lines addressed to them, and emits them as JSONL on stdout — which the harness `Monitor` tool follows.

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
        (stream)             (once-loop          (once-loop
                              or stream)          or stream)
```

Every agent is symmetric: anyone can message anyone, anyone can broadcast. The "lead" is just an agent with `main_` prefix and `is_main:true` in the registry.

## Main agent flow (you're the orchestrator)

```bash
# 1. Attach as main. login auto-registers on first use — no separate register
#    step. Run via run_in_background:true so your main turn can keep working
#    while a background process tails messages back to you via Monitor.
tools agents login --agent-main --agent-name lead                  # (background; stream mode)

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
# Claude Code (you have access to the Monitor tool): use stream mode + background spawn.
tools agents login --agent-name researcher           # run via run_in_background:true,
                                                     # then use Monitor on that shell to
                                                     # receive each new line as it arrives.
#
# Other hosts (no Monitor): use --once in a loop.
while true; do
  tools agents login --agent-name researcher --once  # blocks until a message arrives,
                                                     # prints it, exits 0. Re-invoke.
done
```

> ⚠️ **Monitor only stdout, never stderr.** `login`'s stdout is the JSONL event stream. Stderr is for diagnostics (auto-registration notices, the resume-hint on exit, warnings). If you pipe with `2>&1` you'll see log lines in your event stream and the agent will treat them as malformed events. Correct form: `tools agents login --agent-name X | <pipeline>` — no `2>&1`. If using a Monitor harness directly, point it at stdout only.

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
```

## What you receive on the `login` stream

Each event is a JSON line. The most important `type` values:

| type | meaning |
|---|---|
| `message` | someone sent you (or broadcast) something. There is no separate `respond`/`ack` event — a reply is a `message` with `in_reply_to` set to the original `message_id` (empty `body` = pure ack). |
| `logged_in` / `logged_out` | a peer joined or left. Main agents see real joins/leaves by default; non-main peers see nothing unless the swarm was started with `--debug`. `--once`-mode polling churn is always hidden. |

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

On exit (signal, cap, or crash), the tool prints a `tools agents login ...` resume command on **stderr** so the caller knows exactly how to continue.

## Session resolution

The CLI auto-detects the session in this order:

1. `--session <id>` explicit
2. `$CLAUDE_CODE_SESSION_ID` env var (set by Claude Code; subagent Bash inherits it)
3. Single session active (feed touched) in the last 60 seconds
4. Otherwise: a friendly error asking for `--session` or `$CLAUDE_CODE_SESSION_ID`

You normally don't pass `--session` — it's automatic.

## Common pitfalls

- **Don't poll the file yourself with `cat`.** Use `login` (or `login --once`). The tool handles cursors, dedup, and filtering.
- **There's no separate register step.** `login --agent-name X` auto-registers X the first time it's called — just spawn the subagent and have it call `login` directly.
- **Don't message agents that aren't registered.** You'll get an error. Call `discover` if unsure.
- **Don't expect mid-tool-call interrupts.** Stream-mode `login` delivers between tool calls (via Monitor), `login --once` returns when next called. Neither preempts a running tool.
- **One main per session.** A second `login --agent-main` errors. Use a different `--agent-name` for additional coordinators.

## Quick reference

| Command | Purpose |
|---|---|
| `tools agents login --agent-main --agent-name lead [--debug]` | Auto-register + attach as main, stream mode (optionally enable verbose lifecycle for the whole swarm) |
| `tools agents login --agent-name X` | Auto-register + attach as X, stream mode (Monitor follows stdout) |
| `tools agents login --agent-name X --once` | Auto-register + attach, one-shot mode (poll loop) |
| `tools agents login --agent-id Y --agent-name X` | Attach with a chosen id |
| `tools agents message --from X --to Y --body '...'` | Direct |
| `tools agents message --from X --body '...'` | Broadcast (every peer except the sender) |
| `tools agents message --from X --reply 0001 --body '...'` | Reply (auto-routes to the original sender) |
| `tools agents message --from X --reply 0001` | Pure ack (no body) |
| `tools agents discover` | List all agents in session |
| `tools agents listen` | Human-facing color-formatted feed follower (sees everything) |

### ID formats (per session)

- `agent_id` for subagents: `agt_0001` → `agt_ffff` (monotonic, 4-hex zero-padded)
- `agent_id` for the main agent: `main_<sessionSlug>` (derived from session id; recognizable at a glance)
- `message_id`: `0001` → `ffff` (monotonic, 4-hex, same cap as agent_id)
- `seq`: monotonic feed sequence number (decimal, unbounded for v1 practical use)

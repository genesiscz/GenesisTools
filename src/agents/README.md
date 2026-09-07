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
tools agents login --agent-name lead --kinds message,error     # receiver-side verbosity filter
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

## Session resolution

Resolves in order:

1. `--session <id>` explicit
2. `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION` (set by `tools codex spawn` / `tools grok run` — the parent saying which swarm to join)
3. The host session id: `$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`, `$GROK_SESSION_ID`, `$COPILOT_AGENT_SESSION_ID`. When several are set (a worker inherits its parent's), the one whose swarm ALREADY EXISTS wins, so a worker joins its parent instead of starting an orphan swarm. If none exists, the first present id creates one.
4. Single session active (feed touched) in the last 60 seconds
5. Otherwise: a friendly error asking for `--session` or one of those env vars

The **main** agent's login stream is the swarm inbox: it receives every `message` except its own sends, so a parent `monitor` on `tools agents login --agent-main` sees peer-to-peer hops. Non-main agents still only see mail addressed to them (plus broadcasts).

`login` prints one stdout-only `{type:"ready",...}` JSON line as soon as the slot is attached (not written to the feed). After that, stdout is feed events only. When stderr is not a TTY (piped into a harness monitor), login stays silent on stderr so diagnostics cannot be mistaken for events.

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

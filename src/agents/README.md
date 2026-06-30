# `tools agents` — cross-agent communication

CLI for **bi-directional messaging across a swarm of LLM agents** (main agent ↔ subagent ↔ subagent), via a per-session append-only feed at `~/.genesis-tools/agents/<session-id>/feed.jsonl`. No daemon, no MCP server, no network. Built on the GenesisTools storage primitives.

For the *protocol-level* documentation aimed at the agents themselves (when to call which command, mode choices, etc.), see [`plugins/genesis-tools/skills/agents-talk/SKILL.md`](../../plugins/genesis-tools/skills/agents-talk/SKILL.md) (`/gt:agents-talk`).

For the design background and research, see [`.claude/plans/2026-06-29-AgentsTalk-design.md`](../../.claude/plans/2026-06-29-AgentsTalk-design.md).

## Commands

```bash
tools agents login --agent-name lead --agent-main              # auto-registers + attaches, stream mode
tools agents login --agent-name researcher                     # auto-registers + attaches (stream mode)
tools agents login --agent-id agt_xxx --agent-name X            # attach with a chosen id
tools agents login --agent-name X --once                       # one-shot (poll loop)
tools agents message --from X --to Y --body '...'
tools agents message --from X --body '...'                     # broadcast (no --to)
tools agents message --from X --reply 0001 --body '...'        # reply (auto-routes to original sender)
tools agents message --from X --reply 0001                     # pure ack (no body)
tools agents discover                                          # list registry
tools agents listen                                            # human-facing color follower
```

There is no separate `register` command — `login` auto-registers on first use for a given `--agent-name`/`--agent-id`. There is no separate `respond` command — replies go through `message --reply <msg-id>`.

## Session resolution

Resolves in order:

1. `--session <id>` explicit
2. `$CLAUDE_CODE_SESSION_ID` env var
3. Single session active (feed touched) in the last 60s
4. Otherwise: friendly error asking for `--session` or `$CLAUDE_CODE_SESSION_ID`

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

- `@app/utils/storage` (`withFileLock`, atomic writes)
- `@app/utils/storage/storage` (`atomicWriteFileSync`)
- `@app/utils/storage/stale-lock-sweep` (new — generic stale-PID lock reaper)
- `@app/utils/log-session/jsonl-reader` (line-safe JSONL parsing)
- `@app/utils/json` (`SafeJSON`, never `JSON`)
- `@app/utils/process-alive` (`isProcessAlive`)
- `@app/utils/cli` (`runTool`, `suggestCommand`, `isInteractive`)
- `@app/utils/env` (`env.tools.getHome()`)

## V1 limits

- `message_id` capped at `ffff` (65536 messages per session). Counter exhaustion is a hard error.
- `private:true` is stored in the feed but **not enforced** (anyone with FS access reads everything). V2 will add per-recipient sharding.
- No cross-session messaging. Each session is its own feed.
- No HTTP / TCP transport. Local FS only.
- One main per session (enforced via `is_main:true` uniqueness).
- Listener (`listen`) is read-only; never claim it can interact.

## Build / test

```bash
bunx tsgo --noEmit                                # type-check
tools agents --help                               # show command tree
tools agents login --agent-main --agent-name lead --once --session demo
tools agents discover --session demo
```

## Why a CLI, not an MCP server?

Per the research at `.claude/plans/2026-06-29-AgentsTalk-design.md`: MCP cannot push, only respond to tool calls. By using a CLI whose `login` writes JSONL to stdout, we let the agent's harness `Monitor` tool deliver lines as notifications — sidestepping the entire blocking-MCP-tool / lost-result class of bugs. Send is also a tool call (any `tools agents message`), but receive is a streaming process. This composes with every host that can spawn background processes and read stdout, not just hosts with an MCP client.

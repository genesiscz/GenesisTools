---
status: Accepted
date: 2026-11-18
---

# Ship the node REPL door with its command, method or op

Every new or changed Meetings or Recorder CLI command, service or RPC method, and editor op gets a documented
REPL method in the same change. The method calls the same core and states its return value and CLI twin. Cover
it in the toolset's existing tests and name it in the skill. A generic `apply(ops)` alone leaves editor actions
undiscoverable, and postponing the binding has already left seats, voice backfill and recorder controls out of
agents' reach.

[The rule and In a plan](../../.claude/rules/node-repl-parity.md) in `.claude/rules/node-repl-parity.md`.

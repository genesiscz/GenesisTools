# Cursor

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Dispatch a prompt to Cursor Agent CLI and stream the answer in your terminal.**

A thin wrapper around the `cursor agent` CLI that uses the shared GenesisTools terminal renderer: tool calls on stderr (nicely formatted, colorized), answer text on stdout (clean for piping). Great as a "second opinion" button when Claude Code is stuck.

---

## Quick Start

```bash
# Ask about the current repo
tools cursor "which service creates the reservation?"

# Plan mode
tools cursor --mode plan "outline a refactor of the auth layer"

# Pick a specific model
tools cursor --model gpt-5 "explain this file"

# Raw mode — only the final answer text, no tool calls
tools cursor --raw "give me the summary" > answer.md
```

---

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `<question>` | Positional, all args joined | — |
| `--mode <mode>` | `ask` or `plan` | `ask` |
| `--model <model>` | Model override (e.g. `gpt-5`, `sonnet-4`) | — |
| `--workspace <dir>` | Workspace root for Cursor | cwd |
| `--raw` | Only print the final answer text | off |
| `-h, --help` | Show help | — |

---

## How it works

- Spawns `cursor agent --print --stream-partial-output --output-format stream-json --trust --workspace <dir> <question>`.
- Parses the stream via `CursorStreamAdapter`.
- Text deltas go to stdout; tool-call / metadata blocks are rendered via the shared `TerminalRenderer` to stderr.
- Exit code propagates from the underlying `cursor` process.

---

## Related

- The `cursor` skill (`Skill: cursor`) drives this command from Claude Code when you want a second opinion without leaving the session.
- `tools ask` — for the full multi-provider LLM client.

# DarwinKit

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Apple on-device ML from the terminal.**

Command-line access to macOS on-device ML / CoreML capabilities through the shared DarwinKit native bridge — things like text embeddings, NLP classification, vision, and other Apple-framework primitives without leaving the shell.

---

## Quick Start

```bash
# Interactive menu (TTY only) — pick a command, fill in args via prompts
tools darwinkit

# List everything the CLI exposes
tools darwinkit --help

# Run a specific command with explicit args
tools darwinkit <command> --format json
```

---

## Global Options

| Option | Description |
|--------|-------------|
| `--format <fmt>` | Output format: `json`, `pretty`, `raw` |

Each subcommand can also take its own positional arguments and flags — run `tools darwinkit <command> --help` for details.

---

## Modes

| Mode | Trigger |
|------|---------|
| **Interactive** | `tools darwinkit` with no args in a TTY — clack menu with grouped commands |
| **Help dump** | `tools darwinkit` in a non-TTY, or `--help` — prints every command grouped by category |
| **CLI** | `tools darwinkit <command> [args]` — runs once and prints the result in the requested format |

---

## Notes

- Commands are defined in `src/darwinkit/lib/commands.ts` and are grouped by capability — run the tool to see the live list.
- Output is shaped through `formatOutput(result, format)` so `--format raw` emits a raw payload suitable for piping, and `json` emits canonical JSON.
- The shared DarwinKit bridge is closed on exit (`closeDarwinKit()`), so the process shuts down cleanly.

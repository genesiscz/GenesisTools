# Benchmark

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Lightweight command-benchmarking runner — save, run, and compare timed command recipes.**

Define benchmarks once (command + args + expected behaviour), then run/list/edit/diff them from the CLI. Under the hood it records per-run history so you can see how a command's timing drifts over releases.

---

## Quick Start

```bash
# Run a saved benchmark interactively (no args)
tools benchmark

# Add a benchmark
tools benchmark add

# List benchmarks
tools benchmark list

# Show one + its recent runs
tools benchmark show <name>

# Run a benchmark by name
tools benchmark run <name>

# Edit / remove
tools benchmark edit <name>
tools benchmark remove <name>

# Historical runs
tools benchmark history <name>
```

---

## Commands

| Command | Description |
|---------|-------------|
| `run [name]` | Run a benchmark by name, or pick interactively |
| `add` | Create a new benchmark definition |
| `list` | List all benchmarks with their last run time |
| `show <name>` | Show the definition + recent history |
| `edit <name>` | Edit a benchmark |
| `remove <name>` | Delete a benchmark |
| `history <name>` | Show the run history for one benchmark |

Run each subcommand with `--help` for the full option list.

---

## Storage

Benchmark definitions and history live under `~/.genesis-tools/benchmark/`. History is JSON, so you can diff it with any tool.

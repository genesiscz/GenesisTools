# Port

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=flat-square)

> **Inspect, list, watch, and clean processes that own local ports.**

A dev-friendly replacement for `lsof -i :PORT | grep LISTEN | awk ... | xargs kill`. Interactively pick which PID(s) to kill, watch ports open/close in real time, or purge orphaned listeners in one shot.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Per-port inspection** | `tools port 3000` shows every PID + process + state on that port |
| **Interactive kill** | `--kill` prompts you to select PIDs, listener-only, or everything |
| **Dev-focused `ps`** | `tools port ps` filters out system noise by default |
| **Watch mode** | `tools port watch` streams open/close events with colors |
| **Orphan cleanup** | `tools port clean` kills zombie/orphaned listeners |

---

## Quick Start

```bash
# Show everything listening (dev processes only by default)
tools port

# Inspect a specific port
tools port 3000

# Kill whatever is on port 3000 (interactive selection)
tools port 3000 --kill

# Kill without confirmation
tools port 3000 --kill --yes

# Watch ports live
tools port watch

# Clean orphaned / zombie listeners
tools port clean
```

---

## Commands & Options

### Root — inspect a port or list listeners

| Option | Description |
|--------|-------------|
| `[port]` | Port number to inspect; omit to list all listening ports |
| `-a, --all` | Include system processes and listeners |
| `-k, --kill` | Prompt to kill PIDs owning the port (or all with `-y`) |
| `-y, --yes` | Skip confirmation prompts |

### `ps` — process overview

Colorful process listing focused on dev workflows.

| Option | Description |
|--------|-------------|
| `-a, --all` | Include system processes |

### `clean` — kill orphaned listeners

Finds zombie / orphaned listeners (e.g. leftover `bun run dev` processes) and terminates them.

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompts |

### `watch` — stream port events

| Option | Description |
|--------|-------------|
| `-a, --all` | Include system listeners |
| `-i, --interval <ms>` | Polling interval in milliseconds (min 250, default 2000) |

---

## How it works

Internally shells out to `lsof` / `ps` to enumerate sockets and processes. Each poll is a fresh enumeration, so watch intervals below ~250 ms are rejected to keep load sane. Interactive prompts use clack; in non-interactive shells the tool prints a suggested `--yes`-style command instead of blocking.

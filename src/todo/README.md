# Todo

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Task tracking for AI-assisted development sessions.**

A small SQLite-backed todo CLI designed to be driven by Claude Code / Cursor during long debugging or implementation sessions. Tasks carry status, notes, and can be exported/imported as JSON so they survive across sessions and machines.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Status lifecycle** | `pending -> in-progress -> completed` (with `block` and `reopen`) |
| **Search & filter** | `search` over titles/notes; `list` with status filters |
| **Export / import** | JSON round-trip for sharing or archiving |
| **Sync** | `sync` keeps tasks consistent across sessions/machines |

---

## Quick Start

```bash
# Create a task
tools todo add "Fix race in token refresh"

# List open tasks
tools todo list

# Start / complete / block / reopen
tools todo start <id>
tools todo complete <id>
tools todo block <id>
tools todo reopen <id>

# Search
tools todo search "token"

# Export / import
tools todo export > tasks.json
tools todo import tasks.json
```

---

## Commands

| Command | Description |
|---------|-------------|
| `add <title> [--notes]` | Create a new task |
| `list [--status <s>]` | List tasks, optionally filtered by status |
| `show <id>` | Show full details of one task |
| `start <id>` | Mark as `in-progress` |
| `complete <id>` | Mark as `completed` |
| `block <id>` | Mark as `blocked` |
| `reopen <id>` | Revert to `pending` |
| `edit <id>` | Edit title / notes interactively |
| `remove <id>` | Delete a task |
| `search <query>` | Full-text search across tasks |
| `sync` | Synchronize local task store |
| `export` | Emit tasks as JSON |
| `import <file>` | Import tasks from JSON |

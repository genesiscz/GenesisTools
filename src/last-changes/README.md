# :clock1: Last Changes

> **View uncommitted git changes grouped by modification time**

A command-line tool that shows your uncommitted git changes organized by when they were last modified, helping you understand your recent work at a glance.

---

## Features at a Glance

| Feature | Description |
|---------|-------------|
| :clock3: **Time Grouping** | Files grouped by recency (Last hour, Last 3 hours, Today, etc.) |
| :art: **Color-Coded Status** | Yellow=modified, Green=added, Red=deleted, Blue=renamed |
| :mag: **Relative & Absolute Times** | Shows both "5 minutes ago" and exact timestamp |
| :git: **Commit Mode** | View changes from the last N commits instead |
| :file_folder: **Untracked Expansion** | Recursively shows files inside untracked directories |
| :wrench: **Verbose Mode** | Debug logging for troubleshooting |

---

## Quick Start

```bash
# Show all uncommitted changes grouped by time
tools last-changes

# Show changes from the last 5 commits
tools last-changes --commits 5

# Enable verbose logging
tools last-changes --verbose
```

---

## Options Reference

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--commits` | `-c` | Show changes from the last N commits | uncommitted |
| `--verbose` | `-v` | Enable verbose logging | `false` |

---

## Output Example

```
📋 Uncommitted Changes (4 files):

Last hour (2 files):
  M   src/feature.ts (modified (unstaged))
      5 minutes ago (Jan 15, 2025, 10:23:45 AM)
  A   src/new-file.ts (added (staged))
      12 minutes ago (Jan 15, 2025, 10:16:22 AM)

Last 3 hours (1 file):
  ??  docs/notes.md (untracked)
      2 hours ago (Jan 15, 2025, 08:30:11 AM)

Yesterday (1 file):
  M   config.json (modified (staged))
      1 day ago (Jan 14, 2025, 04:15:33 PM)
```

---

## Status Colors

| Status | Color | Description |
|--------|-------|-------------|
| `M ` | Yellow | Modified (staged) |
| ` M` | Yellow | Modified (unstaged) |
| `MM` | Yellow | Modified (staged & unstaged) |
| `A ` | Green | Added (staged) |
| `D ` | Red | Deleted |
| `R ` | Blue | Renamed |
| `C ` | Cyan | Copied |
| `??` | Gray | Untracked |

---

## Time Groups

Files are automatically grouped into these time buckets:

- **Last hour** - Modified within 60 minutes
- **Last 3 hours** - Modified 1-3 hours ago
- **Last 6 hours** - Modified 3-6 hours ago
- **Last 12 hours** - Modified 6-12 hours ago
- **Today** - Modified 12-24 hours ago
- **Yesterday** - Modified 1-2 days ago
- **Last N days** - Modified 2-7 days ago
- **Older** - Modified more than 7 days ago

---

## Use Cases

### Review Your Work Session
```bash
# See what you've touched recently before committing
tools last-changes
```

### Understand Commit History
```bash
# Review files changed in the last 10 commits
tools last-changes -c 10
```

### Debug File Detection
```bash
# See which files are being processed
tools last-changes --verbose
```

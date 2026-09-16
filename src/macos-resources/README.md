# macOS Resources

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Terminal dashboard for CPU, memory, and open-file usage across running processes.**

An Ink-based TUI that shows a live, sortable process table with CPU %, memory MB, and open-file counts. Filter by process name, set alert thresholds, and optionally fire desktop notifications or voice alerts when a threshold is breached.

---

## Quick Start

```bash
# Full dashboard
tools macos-resources

# Only processes with "chrome" in the name, with desktop notifications
tools macos-resources --process chrome --notify

# Alert when any process exceeds 80% CPU or 1000 MB RAM
tools macos-resources --cpulimit 80 --memorylimit 1000

# Open-files watchdog with voice alert
tools macos-resources --fileslimit 100 --say
```

---

## Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--process <name>` | `-p` | Filter processes by name or PID |
| `--cpulimit <percent>` | `-c` | Alert when CPU usage exceeds the given percentage |
| `--memorylimit <MB>` | `-m` | Alert when memory usage exceeds MB |
| `--fileslimit <count>` | `-f` | Alert when open files exceed count |
| `--interval <seconds>` | `-i` | Seconds between refresh cycles (default 5) |
| `--notify` | `-n` | Fire a desktop notification on alert |
| `--say` | `-s` | Speak the alert aloud |
| `--help` | `-h` | Show help |

---

## Controls (in the TUI)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate processes |
| `f` | Toggle file view for the selected process |
| `r` | Refresh now, including a fresh open-files count for every process |
| `s` | Toggle sort (CPU / PID / Files) |
| `q` | Quit |

---

## Notes

- One refresh cycle per `--interval`: a single `ps -axo` for every process, then one batched `lsof -p a,b,c,...` per 60 pids for the open-file counts (the selected process every cycle, the rest once a minute). Nothing is spawned through a shell. Some processes refuse `lsof` and show `?`; they are not re-asked every cycle.
- The table shows only the rows that fit the terminal, with a `rows X-Y of N` line above it, and scrolls to keep the selection in view. Rendering every process cost three terminal lines each, which at two thousand processes was most of a core and gigabytes of heap.
- The alert hooks call `tools notify` and `tools say` — so configuration, sound, and muting for those tools apply here too.

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
| `--notify` | `-n` | Fire a desktop notification on alert |
| `--say` | `-s` | Speak the alert aloud |
| `--help` | `-h` | Show help |

---

## Controls (in the TUI)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate processes |
| `f` | Toggle file view for the selected process |
| `r` | Refresh |
| `s` | Toggle sort (CPU / PID / Files) |
| `q` | Quit |

---

## Notes

- Uses `ps` under the hood for process stats and `lsof` for open files. Some processes require elevated privileges for full visibility.
- The alert hooks call `tools notify` and `tools say` — so configuration, sound, and muting for those tools apply here too.

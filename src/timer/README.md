# Timer

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Bun-orange?style=flat-square)

> **Focus timer with countdown, Pomodoro cycles, and completion notifications.**

A small CLI Pomodoro / countdown timer. Runs in the foreground with a live countdown, or detaches into a background process so you can keep working. When a cycle ends it can fire a desktop notification (`tools notify`) and/or speak the completion message aloud (`tools say`).

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Flexible durations** | Accepts `25m`, `1h30m`, `90s`, or a plain number of minutes |
| **Pomodoro cycles** | `--repeat <n>` runs the same timer back-to-back |
| **Background mode** | `--bg` detaches the process; `list`/`cancel` manage it later |
| **Completion hooks** | `--notify` sends a desktop banner, `--say` speaks aloud |
| **Interactive wizard** | Run `tools timer` with no args for a clack prompt |

---

## Quick Start

```bash
# 25-minute focus session with a desktop notification
tools timer 25m "Deep work" --notify

# Pomodoro — four 25-minute cycles in the background
tools timer 25m "Pomodoro" --repeat 4 --bg --notify --say

# Short break (seconds), speak when done
tools timer 90s "Stretch" --say

# No args -> interactive wizard (duration, title, actions, fg/bg, repeat)
tools timer
```

---

## Options (root command)

| Option | Description | Default |
|--------|-------------|---------|
| `[duration]` | Duration: `25m`, `1h30m`, `90s`, or a number of minutes | — |
| `[title]` | Timer title / label shown in the countdown and notification | — |
| `--notify` | Send a desktop notification on completion | off |
| `--say` | Speak a completion message aloud | off |
| `--bg` | Detach into a background process | off |
| `--repeat <n>` | Number of cycles (Pomodoro) | `1` |

Max duration: ~24.8 days (JS `setTimeout` limit).

---

## Subcommands

| Command | Description |
|---------|-------------|
| `tools timer list` | Show active background timers with remaining time, cycle, and PID |
| `tools timer cancel [id]` | Cancel a background timer by ID, index, or interactively pick one |

---

## Examples

Short focus block, blocks the terminal with a live countdown:

```bash
tools timer 25m "Write docs"
```

Long Pomodoro set, detached, with both notification + voice:

```bash
tools timer 25m "Pomodoro" --repeat 4 --bg --notify --say
tools timer list          # check what's running
tools timer cancel        # interactively cancel if needed
```

---

## How it works

- Foreground mode writes the countdown to stdout and awaits completion.
- Background mode spawns a detached `bun run` child with `__bg-run__` and records an entry in `~/.genesis-tools/timer/config.json` with PID + end-time.
- `list` prunes dead PIDs on read; `cancel` kills by PID and removes the entry.
- Completion hooks are fired by spawning `tools notify` / `tools say` — so their own config (sound, voice, mute) applies.

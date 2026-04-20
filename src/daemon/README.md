# Daemon

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **General-purpose background task scheduler daemon.**

A long-running process that owns cron-like scheduled tasks (think: "run `tools automate preset run daily-digest` every morning at 09:00"). Tasks are declared in config, run in the background, and log their output for inspection.

---

## Quick Start

```bash
# First-time setup (interactive if TTY, otherwise use subcommands)
tools daemon

# Start / stop the daemon
tools daemon start
tools daemon stop
tools daemon restart

# Check status
tools daemon status

# Tail logs
tools daemon logs

# Install as a LaunchAgent / systemd service
tools daemon install

# Edit the config
tools daemon config
```

---

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start the daemon in the foreground of a detached process |
| `stop` | Stop the running daemon |
| `restart` | Stop + start |
| `status` | Show daemon PID, uptime, scheduled tasks, next runs |
| `install` | Install as a LaunchAgent (macOS) / systemd unit (Linux) |
| `config` | Open / edit the scheduler config |
| `logs` | Tail recent daemon output |

Running `tools daemon` with no arguments opens an interactive menu for all of the above.

---

## Notes

- Config and state live under `~/.genesis-tools/daemon/`.
- The daemon is the execution engine behind scheduled `automate` presets — see `tools automate --readme` for preset authoring.
- Task output streams to per-task log files so you can debug a flaky job without restarting the daemon.

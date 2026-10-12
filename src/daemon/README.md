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

# Run statistics for the last 24 hours (a menu in a terminal)
tools daemon stats

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
| `stats` | Task run statistics: failure rates, durations, failures with their stderr, run output |

Running `tools daemon` with no arguments opens an interactive menu for all of the above.

---

## Run statistics

`tools daemon stats` reads the per-task run logs inside a time window. The window is the last 24 hours unless `--since` or `--until` says otherwise. From each run log it reads only the first and last record, so a long window stays cheap.

In a terminal with no `--view`, it opens a menu. After each view, the menu comes back with the same filters, until you choose Done. With `--view` or `--json` it prints once and exits, for scripts.

```bash
# Every task: runs, failure rate, p50/p90/p99 durations, and the daemon's own health lines
tools daemon stats --view overview

# One task: counts, a duration histogram, runs per hour (or per day past 48 hours), the last failure
tools daemon stats --view task --task ai-usage-poll

# Duration percentiles and histograms for every task over a week
tools daemon stats --view durations --since 7d

# Failures, newest first, each with the last 12 stderr lines
tools daemon stats --view failures --since 2026-10-12 --until 18:00

# The full output of one run (run ids are in the --json output; the menu lists the runs to pick from)
tools daemon stats --view run --run 1a2b3c4d

# The same data as JSON (the shape is `DaemonStats` in lib/stats.ts, version 1)
tools daemon stats --json --since 24h
```

`--since` and `--until` take a duration back from now (`1h`, `24h`, `7d`), a date or ISO time, or `HH:MM` today. `--since all` reads every run log.

---

## Notes

- Config and state live under `~/.genesis-tools/daemon/`.
- The daemon is the execution engine behind scheduled `automate` presets — see `tools automate --readme` for preset authoring.
- Task output streams to per-task log files so you can debug a flaky job without restarting the daemon.

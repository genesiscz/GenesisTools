# tmux

Inspect, create, reset, attach, and snapshot tmux sessions on the default socket.

Extracted from `tools cmux tmux` — `cmux` owns workspace *profiles* (its JSON-RPC
control plane); this tool owns plain tmux session management. The reusable tmux
primitives live in `src/utils/tmux/` and are shared with the dev-dashboard server.

## Commands

```
tools tmux sessions [--json] [--detailed] [--prefix <str>]
    List live tmux sessions. --detailed adds per-pane cwd / current command.

tools tmux create [--name <n>] [--cwd <p>] [--command <sh>] [--attach]
    Create a detached session (shows up in the dev-dashboard tmux hub).
    --attach hands the terminal to it (needs a TTY).

tools tmux session reset <sessionId>
tools tmux session reset --matching <pattern> [--yes] [--skip-replay] [--preset <n>] [--skip-backup]
    Save → kill → restore one session by exact id, or every session whose name
    starts with <pattern>. A backup preset is written first (unless --skip-backup).

tools tmux session attach <id-or-substring>
    Attach by exact name. A substring opens a picker (interactive) or, with no TTY,
    prints the matching candidates and the full session list.

tools tmux presets save [name] [--prefix <str>] [-f] [--skip-history] [--note <t>]
tools tmux presets list [--json]
tools tmux presets restore <name> [--yes] [--suffix <s>] [--only <prefix>] [--dry-run] [--skip-replay]
tools tmux presets delete <name> [--yes]
    Named, persisted tmux session layouts (snapshots of sessions/windows/panes).
```

## Notes

- Presets persist as JSON under `~/.genesis-tools/cmux/tmux-presets/` (kept at the
  legacy cmux path so existing presets keep working; the data is pure tmux).
- `session reset` scrubs the tmux server's global env (`NO_COLOR` unset,
  `COLORTERM=truecolor`) before recreating, so recreated panes render in color.

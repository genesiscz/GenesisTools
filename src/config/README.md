# tools config

> **Manage GenesisTools configuration.**

A small front end for the settings that are global to the toolkit rather than owned by one tool. Today that means optional package preferences and the profiler.

---

## Commands

| Command | Description |
|---------|-------------|
| `packages` | Manage optional package installation preferences |
| `profiling` | Show or change the global profiler (`~/.genesis-tools/GenesisTools/config.json`) |

## Quick start

```bash
tools config packages       # review and change optional package preferences
tools config profiling      # TTY: show settings, then offer to edit. non-TTY: show only
tools config profiling --enable --scopes claude-history
tools config profiling --scopes          # non-TTY: lists known scopes + a filled command
tools config profiling --detail          # non-TTY: Possible: phases, all
tools config --readme                    # print this file
```

---

## Why optional packages exist

Some tools depend on heavy or platform-specific packages that most users never need: local ONNX runtimes, native vector search, browser automation. Rather than install everything for everyone, those packages are optional. `tools config packages` records which ones you want, so a tool that needs one can install it on demand instead of prompting every run.

Per-tool configuration does **not** live here. Each tool owns its own file under `~/.genesis-tools/<tool>/`, for example `~/.genesis-tools/say/config.json`. AI accounts and credentials live under `~/.genesis-tools/ai/` and the encrypted vault at `~/.genesis-tools/security/vault.json`.

Global profiler settings live at `~/.genesis-tools/GenesisTools/config.json`:

```json
{
  "profiling": {
    "enabled": false,
    "scopes": [],
    "stderr": false,
    "file": true,
    "filePath": null,
    "minDurationMs": 0,
    "summaryOnExit": false,
    "detail": "phases"
  }
}
```

Empty `scopes` with `enabled: true` means every scope. Env overrides for one process: `PROFILE`, `PROFILE_TO_STDERR`, `PROFILE_TO_FILE`. Duration lines go to `~/.genesis-tools/logs/<date>-profiling.log`, not the pino day log. `tools config profiling --enable` is the durable switch.

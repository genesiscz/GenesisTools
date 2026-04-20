# Zsh

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-zsh%20%7C%20bash-blue?style=flat-square)

> **Shell enhancement manager with toggleable features and two hook modes.**

Installs a small hook into your `.zshrc` / `.bashrc` that can be enabled/disabled per feature. Features are small shell helpers bundled with GenesisTools (notifications, port helpers, TTS-on-long-commands, ...). Two hook modes trade off startup cost vs flexibility.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Install / uninstall** | Adds/removes a single-line sourcing block in your rc files |
| **Static mode** | Regenerates a `hook.sh` on enable/disable — ~1 ms shell startup |
| **Dynamic mode** | Spawns `bun` per shell — ~1 s startup, zero regeneration |
| **Per-feature toggles** | `enable <name>` / `disable <name>` |
| **Feature list** | Opt-in notifications, port helpers, TTS, dotdotdot, etc. |

---

## Quick Start

```bash
# Interactive installer (picks rc files, mode, features)
tools zsh install

# List available features and their current state
tools zsh list

# Toggle one feature
tools zsh enable notify
tools zsh disable dotdotdot

# Print the hook script (useful for dynamic mode debugging)
tools zsh hook

# Remove everything
tools zsh uninstall
```

---

## Commands

| Command | Description |
|---------|-------------|
| `install` | Install hooks into selected shell rc files |
| `uninstall` | Remove hooks from all rc files |
| `enable <feature>` | Enable a feature |
| `disable <feature>` | Disable a feature |
| `list` | Show every feature with enabled/disabled status and target shell |
| `hook` | Print the current hook script to stdout (for dynamic mode) |

---

## Hook Modes

| Mode | Startup | Trade-off |
|------|---------|-----------|
| **Static** | ~1 ms | Regenerates `hook.sh` each time you toggle a feature |
| **Dynamic** | ~1 s | Always-live; spawns `bun` on every shell start |

Pick **static** unless you toggle features constantly.

---

## Storage

Config at `~/.genesis-tools/zsh/config.json` (`enabled: []`, `hookMode: "static"|"dynamic"`). The generated `hook.sh` sits alongside.

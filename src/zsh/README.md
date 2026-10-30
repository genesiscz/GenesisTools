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

# Static zsh completions for the CLIs on PATH (vitrinka, gh, glab, docker, glow, bun)
tools zsh completions --list        # what is found and what would be installed; changes nothing
tools zsh completions --dry-run     # the planned ~/.zshrc diff; writes nothing
tools zsh completions               # pick in a terminal (all found are checked), confirm the diff, write
tools zsh completions refresh       # after a CLI update: regenerate the files, report which changed
tools zsh completions uninstall     # remove the block and put back the hand-made wiring it replaced
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
| `completions [--yes] [--list] [--dry-run] [--replace-hand] [--rc <path>]` | Generate static zsh completion files once and wire them with one block in the rc file |
| `completions refresh` | Regenerate every installed completion file and say which changed and which CLI changed version |
| `completions uninstall` | Remove the block (`--dry-run` and `--rc` of `completions` apply) and put back replaced hand-made wiring |

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

---

## Completions

Many CLIs tell you to put `eval "$(<cli> completion zsh)"` in `~/.zshrc`. That starts the CLI on every new shell.
`tools zsh completions` runs each generator **once**, writes the script to `~/.genesis-tools/zsh/completions/_<cli>`,
and wires the files with one marked block at the end of the rc file:

```zsh
# >>> genesis-tools zsh completions >>>
__gt_completions="$HOME/.genesis-tools/zsh/completions"
fpath=($__gt_completions $fpath)
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -C; }
[[ -r $__gt_completions/_gh ]] && autoload -Uz _gh && compdef _gh gh
[[ -r $__gt_completions/_bun ]] && source $__gt_completions/_bun
unset __gt_completions
# <<< genesis-tools zsh completions <<<
```

It never writes an `eval` line, and no CLI runs when a shell starts.

- **Two wirings.** `fpath` (cobra CLIs: vitrinka, gh, glab, docker and glow) marks `_<cli>` autoloaded and
  runs `compdef`, so zsh reads the file only on the first Tab. Cobra scripts call `<cli> __complete` on each Tab, so a
  file written once stays current for new subcommands and flags. `source` (bun) sources the file, because bun's script
  defines helper functions and calls `compdef` at its end.
- **Why at the end and with `compdef`.** The block registers each CLI itself instead of relying on a compinit dump:
  `compinit -C` never rebuilds an existing dump, so a folder added to `fpath` before it would not be seen.
- **Hand-made wiring.** The tool finds the wiring it did not write: the `# vitrinka-completion` marker block, a pasted
  cobra script (glow), an `eval "$(<cli> completion zsh)"` line, bun's `source $BUN_INSTALL/_bun` and Docker
  Desktop's block. It never changes one without asking: in a terminal it shows the block and asks; without a terminal
  it keeps them unless you pass `--replace-hand`. A kept block that already wires its CLI makes the tool skip that
  CLI. Docker Desktop's block only adds an fpath entry, Docker Desktop rewrites it, so it always stays.
- **The vitrinka marker stays.** `vitrinka setup` reads `# vitrinka-completion` as "completion done", so the
  replacement keeps a line that starts with it.
- **Uninstall is a round trip.** The state file records each replaced block's original lines; `uninstall` (and
  deselecting a CLI on a later run) puts them back. The generated files stay; delete them with `tools rm`.
- **Not supported yet:** `tools` itself (commander has no zsh generator) and grok (its installer writes its own
  fpath entry and `compinit`).

State: `~/.genesis-tools/zsh/completions.json` holds, per CLI, the file, the wiring, the `--version` line it was
generated with, the time and a sha256, plus the replaced hand blocks. `--list` and `refresh` say when a CLI's
version changed since its file was generated.

Startup cost: `bun scripts/benchmarks/zsh/startup.ts --runs 20` copies the rc into temp folders (never edits it),
runs `/usr/bin/time -p zsh -i -c exit` interleaved per arm through `ZDOTDIR`, and prints median and min/max of wall
and CPU time for the rc as it is, with the block, without the `tools zsh hook` line, and that line alone.

# tools zsh

`tools zsh` manages what GenesisTools adds to your shell start: one hook that loads opt-in helper features (`...`
expansion, a notification when a long command finishes, `port` and `speak` shortcuts), static zsh completion files for
common CLIs, and the cmux command-capture block. Use it to get these helpers without editing `~/.zshrc` by hand, and
without a CLI that starts on every new shell.

## Quick start

```bash
tools zsh install                  # pick rc files, hook mode and features (interactive)
tools zsh list                     # every feature, enabled or not, and the shell it works in
tools zsh enable notify            # turn one feature on (static mode rewrites hook.sh)
tools zsh completions --dry-run    # the files and the ~/.zshrc diff static completions would make
tools zsh completions              # pick CLIs, confirm the diff, write the files and the rc block
tools zsh completions refresh      # after a CLI update: regenerate the files, report which changed
```

A change reaches new shells only. After an `install` or an `enable`, `source ~/.zshrc` also applies it to the shell
you have. After a `disable` or an `uninstall`, open a new shell: nothing unbinds a feature that a shell has loaded, so
a re-sourced shell keeps it.

## Commands

Global flags: `--readme` prints this file, `-v, --verbose` turns on debug logging, `-V, --version` prints the version.

### Shell hook and features

- `install`: interactive, no flags. On a first install it asks for the rc files, the hook mode and the features (all
  four are checked). The rc files on offer are the ones that exist of `~/.zshrc`, `~/.bashrc` and `~/.bash_profile`;
  when none exists it offers `~/.zshrc` and `~/.bashrc`. When a hook is already installed, it prints the mode and the
  enabled features and offers Reinstall (same mode), Switch hook mode, Uninstall or Cancel.
- `uninstall`: removes the hook block from each of those rc files that has it. `config.json` and `hook.sh` stay. The
  completions block and the cmux block also stay; remove them with `tools zsh completions uninstall` and
  `tools zsh cmux uninstall`.
- `enable <feature>` and `disable <feature>`: add or remove the name in `enabled`. In static mode they also rewrite
  `hook.sh`. An unknown name exits 1 and prints the valid names.
- `list`: a table of Name, Description, Status (`enabled` or `disabled`) and Shell (`both` or `zsh`).
- `hook`: prints the hook script for the features enabled in the current `config.json` on stdout. Dynamic mode runs it
  at every shell start. It never reads `hook.sh`; in static mode its output is what `hook.sh` holds after the last
  `install`, `enable` or `disable`.

### The features

- **`dotdotdot`** (zsh only): three or more dots become parent folders, N dots to N-1 segments, up to 10 dots.
  `cd ...` runs `cd ../..` and `cd ....` runs `cd ../../..`. It wraps two zle widgets: Enter (`accept-line`) expands
  the line before it runs, and Tab expands it, completes, and puts the dots back.
  - Enter rewrites every run of three or more dots anywhere in the line, inside quotes too. `git diff main...feature`
    runs as `git diff main../..feature`, and `echo "Loading..."` prints `Loading../..`. Disable the feature if you type
    such lines.
  - It wraps the widget that Tab is bound to when the hook loads. A plugin that binds Tab later turns the Tab part off.
- **`notify`** (zsh and bash): when a command ran 30 s or more (fixed in the feature script) and the terminal is not
  the frontmost app, `tools notify` posts "Command Finished" with the Ping sound. The text is a check or a cross mark
  for the exit code, the command (longer than 60 characters is cut to 57 plus `...`), and the time (`2m 5s`).
  - The frontmost app comes from `osascript` (System Events). It is compared with a name made from `$TERM_PROGRAM`:
    `iTerm2`, `Terminal`, `Code` (VS Code), `Warp`, `tmux`, or the raw `$TERM_PROGRAM` value for any other terminal.
  - zsh uses `add-zsh-hook preexec` and `precmd`. Bash sets the `DEBUG` trap, which replaces a `DEBUG` trap you
    already have, and adds itself to `PROMPT_COMMAND`.
- **`port`**: a shell function `port` that runs `tools port`. It is defined only when no other `port` command exists,
  or when the `port` found has `/tools` in its path, so MacPorts' `port` keeps its name.
- **`speak`**: a shell function `speak` that runs `tools say` with the same arguments.

### Static completions: `completions`

`tools zsh completions` runs each CLI's completion generator once, writes the script to
`~/.genesis-tools/zsh/completions/_<cli>`, and wires the files with one marked block at the end of the rc file. In a
terminal it asks which CLIs to wire (all found are checked), asks about each hand-made wiring it found, shows the rc
diff and asks once more before it writes.

| Flag             | Effect                                                              |
|------------------|---------------------------------------------------------------------|
| `-y, --yes`      | No prompts: every CLI found, hand-made wiring kept                  |
| `--list`         | Table of the CLIs found and their state; writes nothing             |
| `--dry-run`      | Prints the files it would generate and the rc diff; writes nothing  |
| `--replace-hand` | With `--yes` or `--dry-run`: replace the hand-made wiring instead   |
| `--rc <path>`    | The rc file (default `$ZDOTDIR/.zshrc`, else `~/.zshrc`)            |

- `completions refresh`: regenerates every installed file whose CLI is still on PATH. A table shows each file as
  `unchanged`, `rewritten` or `failed`, and names a CLI whose version changed. A CLI no longer on PATH keeps its file.
  With `--dry-run` it only names what it would regenerate and runs no generator. It uses the rc file recorded in the
  state, not `--rc`, and it warns when that rc file has no completions block.
- `completions uninstall`: removes the block and puts back the hand-made wiring the install replaced. It takes
  `--dry-run` and `--rc`. The generated files stay; delete the folder with `tools rm` when you no longer need it.

The options of `completions` also work after the subcommand: `tools zsh completions uninstall --dry-run`. `refresh`
reads only `--dry-run`.

The CLIs it knows, when they are on PATH:

| CLI      | Generator                        | Wiring   |
|----------|----------------------------------|----------|
| vitrinka | `vitrinka completion zsh`        | `fpath`  |
| gh       | `gh completion -s zsh`           | `fpath`  |
| glab     | `glab completion -s zsh`         | `fpath`  |
| docker   | `docker completion zsh`          | `fpath`  |
| glow     | `glow completion zsh`            | `fpath`  |
| bun      | `SHELL=/bin/zsh bun completions` | `source` |

Not supported yet: `tools` itself (commander has no zsh generator) and grok (its installer writes its own `fpath`
entry and `compinit`).

### cmux command capture: `cmux`

`tools zsh cmux install`, `tools zsh cmux status` and `tools zsh cmux uninstall` are the same commands as
`tools cmux capture install|status|uninstall`. The cmux README describes what they record and how much they keep:
[Automatic capture](../cmux/README.md#automatic-capture).

| Flag                 | Effect                                                         |
|----------------------|----------------------------------------------------------------|
| `--home <directory>` | The home that holds `.genesis-tools` (default: your home)      |
| `--rc <path>`        | The zsh rc file (default `<home>/.zshrc`, not `$ZDOTDIR`)      |
| `--no-screens`       | Command capture only, no background screen collector           |
| `--json`             | Print the result as JSON                                       |
| `--yes`              | Change the rc file without a prompt                            |
| `--dry-run`          | Print the planned rc block; write nothing, start nothing       |

- `install` writes a `# >>> GenesisTools cmux capture >>>` block that sources `~/.genesis-tools/cmux/capture.zsh`. New
  interactive cmux shells capture commands; shells that already run do not.
- `uninstall` removes that block (and an older bare `source` line of `capture.zsh`), stops the screen collector, and
  keeps the journal data and the installed runtime.
- Each `install` or `uninstall` that changes the rc file first copies it to a new `<rc>.cmux-backup-<time>-<id>` file
  and prints `backup: <path>`. These copies are never removed (see [Files](#files)).
- `status` changes nothing. It shares the flag list, but only `--home`, `--rc` and `--json` change what it does.
- The screen collector is not a login service. After a reboot, run `install` again with the same `--home` and `--rc`.

## How it works

### Hook modes

`install` puts one block in each chosen rc file. The line inside depends on the mode:

```sh
# GenesisTools shell hook
[ -f ~/.genesis-tools/zsh/hook.sh ] && source ~/.genesis-tools/zsh/hook.sh
# /GenesisTools shell hook
```

```sh
# GenesisTools shell hook
eval "$(tools zsh hook 2>/dev/null)"
# /GenesisTools shell hook
```

| Mode        | Shell start | Trade-off                                                    |
|-------------|-------------|--------------------------------------------------------------|
| **Static**  | about 1 ms  | `enable` and `disable` rewrite `hook.sh`                     |
| **Dynamic** | about 1 s   | Reads the config live; starts `bun` on every shell start     |

Pick **static** unless you toggle features all the time. The hook script holds the text of each enabled feature; a
zsh-only feature is wrapped in `if [ -n "$ZSH_VERSION" ]`, so one `hook.sh` serves zsh and bash. A reinstall or a mode
switch replaces the old block in the same write, and it also finds an older install that left only the start marker
and the hook line.

### What it needs

- **zsh** for `dotdotdot`, the completions block and cmux capture. `notify`, `port` and `speak` also work in bash.
- **`tools` on PATH** in the shell. The features call `tools notify`, `tools port` and `tools say` when they run.
  Dynamic mode also runs `tools zsh hook` (Bun) at every shell start, and its rc line sends errors to `/dev/null`. So
  when `tools` is not on PATH at that point, or the command fails, the shell starts with no features and no message.
- **Automation permission for `notify`.** After each command of 30 s or more, `notify` runs `osascript` to ask System
  Events for the frontmost app. The first time, macOS asks whether your terminal app may control System Events. If
  you refuse, the query answers an empty name, and every long command notifies, also when the terminal is in front.
  [`tools notify`](../notify/README.md) then posts the notification.

### Files

- `~/.genesis-tools/zsh/config.json`: `enabled` (feature names, default `[]`) and `hookMode` (`"static"` or
  `"dynamic"`, default `"static"`).
- `~/.genesis-tools/zsh/hook.sh`: the static hook script, written by `install`, `enable` and `disable` in static mode.
- `~/.genesis-tools/zsh/completions/_<cli>`: one generated completion file per CLI.
- `~/.genesis-tools/zsh/completions.json`: the completions state. Per CLI: the file, the wiring, the first line of its
  `--version` when the file was generated, the time and a sha256. It also holds the rc path and the original lines of
  each hand-made block the install replaced. An unreadable state file is copied to `completions.json.corrupt-<stamp>`
  before a write replaces it.
- `<rc>.bak`: one rolling copy of the rc file as it was before the last write by `install`, `uninstall` or
  `completions`. It sits beside the real file. For a symlinked rc that is next to the link target: `~/.zshrc` linked
  to `~/dotfiles/zshrc` gets `~/dotfiles/zshrc.bak`, inside the dotfiles repo, where git can see it.
- `<rc>.cmux-backup-<time>-<id>`: a new copy of the rc file (mode 600) before each change by `cmux install` or
  `cmux uninstall`, also beside the real file. It is not rolling: the copies pile up. Delete old ones with `tools rm`.
- `~/.genesis-tools/cmux/`: the cmux capture hook, runtime and journal, owned by `tools cmux`.

### How it changes the rc file

The hook and the completions block are written the same way. The new text goes in with one atomic write. When the rc
file is a symlink (into a dotfiles repo, for example), the link stays and the file it names gets the new text. The old
text is kept as `.bak` beside that real file, not beside the link. A dangling link refuses the write. When the file
changed between the read and the write (an editor, another installer), the write is refused and the file stays as it
was. The completions install writes the rc first and the state second. When the state cannot be saved, the rc goes
back to what it was, because without that state no uninstall could put the replaced blocks back.

### Completions in detail

Many CLIs tell you to put `eval "$(<cli> completion zsh)"` in `~/.zshrc`. That starts the CLI on every new shell.
`tools zsh completions` never writes an `eval` line, and no CLI runs when a shell starts. The block looks like this:

```zsh
# >>> genesis-tools zsh completions >>>
# Static files written once by `tools zsh completions`; no CLI runs at shell start.
# After a CLI update: tools zsh completions refresh. Remove: tools zsh completions uninstall.
__gt_completions="$HOME/.genesis-tools/zsh/completions"
fpath=($__gt_completions $fpath)
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -C; }
[[ -r $__gt_completions/_gh ]] && autoload -Uz _gh && compdef _gh gh
[[ -r $__gt_completions/_bun ]] && source $__gt_completions/_bun
unset __gt_completions
# <<< genesis-tools zsh completions <<<
```

- **Two wirings.** `fpath` (the cobra CLIs: vitrinka, gh, glab, docker and glow) marks `_<cli>` autoloaded and runs
  `compdef`, so zsh reads the file only on the first Tab. Cobra scripts call `<cli> __complete` on each Tab, so a file
  written once stays current for new subcommands and flags. `source` (bun) sources the file, because bun's script
  defines helper functions and calls `compdef` at its end.
- **Why at the end and with `compdef`.** The block registers each CLI itself instead of relying on a compinit dump:
  `compinit -C` never rebuilds an existing dump, so a folder added to `fpath` before it would not be seen. A later run
  rewrites the block where it stands.
- **Each file is checked.** A generator must print a script with a `#compdef <cli>` line in its first five lines, and
  finish within 120 s (a generator that runs every subcommand's `--help` took 37 s at load average 45 on 2026-10-30).
  `--version` gets 10 s. A run with an error fails even when the generator exited 0, so a script cut short is never
  installed. A CLI whose generator fails keeps its old file; with no old file it is left out of the block. A file with
  the same content is not rewritten.
- **Hand-made wiring.** The tool finds the wiring it did not write: the `# vitrinka-completion` marker block, a pasted
  cobra script (glow), an `eval "$(<cli> completion zsh)"` or `source <(<cli> completion zsh)` line, bun's
  `source $BUN_INSTALL/_bun` and Docker Desktop's block. It never changes one without asking: in a terminal it shows
  the block and asks; with `--yes` or without a terminal it keeps them unless you pass `--replace-hand`. A replaced
  block becomes one comment line, `# <cli> completion: wired by tools zsh completions`. A kept block that already
  wires its CLI makes the tool skip that CLI. Docker Desktop's block only adds an `fpath` entry and Docker Desktop
  rewrites it, so it always stays.
- **A pasted script is found only when it is complete:** its `#compdef <cli>` line, the `compdef _<cli> <cli>` line
  under it, and the closing `if [ "$funcstack[1]" = "_<cli>" ]` block with its `fi`.
- **The vitrinka marker stays.** `vitrinka setup` reads `# vitrinka-completion` as "completion done", so the
  replacement keeps a line that starts with it.
- **Uninstall is a round trip.** The state file records each replaced block's original lines; `uninstall` (and
  deselecting a CLI on a later run) puts them back.
- **`--list` and `refresh` say when a CLI's version changed** since its file was generated. `--list` runs only each
  found CLI's `--version`.

### Startup cost

The completions block added 0.5 ms of CPU per shell when it was measured (2026-10-30). To measure your own rc:

```bash
bun scripts/benchmarks/zsh/startup.ts --runs 20
```

It copies the rc into temp folders (it never edits the real one), runs `/usr/bin/time -p zsh -i -c exit` through
`ZDOTDIR`, interleaved per arm with one warm-up run each, with the agent variables (`CLAUDECODE`, `CODEX_SHELL`, ...)
removed. It prints the median and the min and max of wall and CPU time, plus the load average. CPU is the steadier
number. The arms: the rc as it is, the rc after `--yes --replace-hand`, the rc plus the block alone, the rc without its
`tools zsh hook` line, an empty rc, that hook line alone, `compinit -C` alone, and `compinit -C` plus the block. Other
flags: `--runs <n>` (default 10), `--rc <path>` (default `~/.zshrc`), `--work <dir>` (default a new temp folder).

## Configuration

- `config.json` holds the feature list and the hook mode (see [Files](#files)). Edit it through `enable`, `disable`
  and `install`. In static mode a hand edit takes effect only when `hook.sh` is written again: a reinstall, or an
  `enable` or `disable` that changes the list.
- `ZDOTDIR`: `completions` uses `$ZDOTDIR/.zshrc` when it is set. `install`, `uninstall` and `cmux` do not read it:
  they look in your home folder, so pass `--rc` to `cmux` when your rc file lives elsewhere.
- `GENESIS_TOOLS_HOME` replaces the home folder that holds `.genesis-tools` (the test suite uses it). The data then
  lives in `$GENESIS_TOOLS_HOME/.genesis-tools/zsh/`, and the `cmux` default home and rc become `$GENESIS_TOOLS_HOME`
  and `$GENESIS_TOOLS_HOME/.zshrc`. Set it to the parent folder, not to a `.genesis-tools` folder. The static rc line
  still names `~/.genesis-tools/zsh/hook.sh`.
- The 30 s `notify` threshold and the 10-dot `dotdotdot` limit are fixed in the feature scripts.

## For agents

- Non-interactive use: `install` has no flags and only prompts; run it in a terminal. `completions` without a
  terminal needs `--yes` or `--dry-run`; otherwise it changes nothing and exits 1. `cmux install` and
  `cmux uninstall` need `--yes` when they would change the rc file and stdin is not a terminal or `--json` is set;
  otherwise they exit 1.
- Read-only commands: `list`, `hook`, `completions --list`, `completions --dry-run`, `completions refresh --dry-run`,
  `completions uninstall --dry-run`, `cmux status`, `cmux install --dry-run` and `cmux uninstall --dry-run`.
- `cmux install|status|uninstall --json` prints the result as JSON. The other commands print text only.
- Exit code 1: an unknown feature name, a missing `--yes` as above, or a thrown error (a refused rc write, a
  completions block without its end marker, a `config.json` that does not parse).

## Troubleshooting

- **`git diff main...feature` or a quoted `...` is rewritten.** The `dotdotdot` feature expands every run of three or
  more dots on Enter. Run `tools zsh disable dotdotdot`.
- **`notify` fires even when the terminal is in front.** The frontmost app name did not match the name made from
  `$TERM_PROGRAM`. That happens inside tmux (`$TERM_PROGRAM` is `tmux`), in a terminal not in the list, and when macOS
  refuses the `osascript` query, which then answers an empty name.
- **`port` runs MacPorts.** By design: the shortcut steps aside for another `port`. Call `tools port`.
- **A toggle has no effect.** A running shell keeps the hook it loaded. After `enable`, open a new shell or run
  `source ~/.zshrc`. After `disable` or `uninstall`, open a new shell. Nothing unbinds a loaded feature, so a
  re-sourced shell keeps the Enter and Tab wrappers of `dotdotdot`, the `notify` hooks and its bash `DEBUG` trap.
- **`Failed to parse config at …/zsh/config.json`.** The file is not valid JSON. `list`, `enable`, `disable`, `hook`
  and `install` over an existing hook exit 1. In static mode new shells still load the last `hook.sh`. In dynamic mode
  the rc line hides the error, so new shells start with no features. Fix the JSON, or delete the file and enable the
  features again.
- **`<rc> changed while GenesisTools was writing it.`** Something else wrote the rc during the run. Nothing was
  written; run the command again.
- **`Completions are installed in <rc>. Uninstall them there before using <other>.`** The state records another rc
  file. Run `tools zsh completions uninstall` (it uses the recorded file), then install with the new `--rc`.
- **`The rc file has "# >>> genesis-tools zsh completions >>>" but no "# <<< genesis-tools zsh completions <<<"
  line.`** The block was cut by hand. Fix or delete the rest of the block, then run again.
- **`--list` says `version changed: refresh`.** Run `tools zsh completions refresh`. Cobra files keep working in the
  meantime, because they ask the CLI on each Tab.
- **`--list` says `wired by hand`, and new shells still start the CLI.** The install kept your `eval` line. Run
  `tools zsh completions` in a terminal and accept the replacement, or `tools zsh completions --yes --replace-hand`.
- **`... did not finish within 120 s` or `printed no "#compdef <cli>" script`.** The generator failed; the old file,
  if any, stays. Run it by hand to see why, then `tools zsh completions refresh`.
- **`Could not put back (its "..." line is gone)`.** You edited or deleted the comment line that replaced a hand
  block. That block's original lines stay in `completions.json`; put them back by hand.

## Related

- [`tools cmux`](../cmux/README.md): `tools cmux capture` is the same capture installer as `tools zsh cmux`.
- [`tools notify`](../notify/README.md): posts the notification of the `notify` feature.
- [`tools port`](../port/README.md) and [`tools say`](../say/README.md): what the `port` and `speak` shortcuts run.
- [`tools rm`](../rm/README.md): deletes the generated completion files when you no longer need them.

# tools update

`tools update` brings a GenesisTools checkout up to date. It runs `git pull`, runs `bun install` (with one clean
retry), rebuilds an installed GenesisTools.app whose sources changed, offers to restart servers that still run old
code, refreshes the Claude Code plugin, and offers to register the genesis-tools MCP server. Run it whenever you
want the newest tools; `install.sh` runs it too.

## Quick start

```bash
tools update                # pull, install, refresh the app and the Claude Code plugin
tools update --no-plugins   # the same, but leave the Claude Code plugin alone
tools update dev            # move to the newest feat/<date>-enhancements-unified branch
tools update                # after dev: switch back to the branch you came from, then pull
tools update --readme       # print this page
```

## Commands

| Command            | What it does                                       |
| ------------------ | -------------------------------------------------- |
| `tools update`     | Update the current branch (or leave the dev channel) |
| `tools update dev` | Switch to the newest dev branch until the next update |

| Flag            | Effect                                                         |
| --------------- | -------------------------------------------------------------- |
| `--no-plugins`  | Skip the Claude Code marketplace and plugin step               |
| `-v, --verbose` | Debug logging (see Troubleshooting: it misses the later steps) |
| `--readme`      | Print this README and exit                                     |
| `-h, --help`    | Show help                                                      |

Without `--no-plugins` the plugin step runs (after a question in a terminal).

`--no-plugins` works on both commands, before or after `dev`: `tools update --no-plugins dev` and
`tools update dev --no-plugins` both skip the plugin step. `-v` belongs to the root command only.

## How it works

### What one run does

The update runs in two processes. The first one moves the source:

1. **Finds the checkout.** It is `$GENESIS_TOOLS_PATH` when that is set (`install.sh` writes it into your shell rc
   file), else the checkout that holds the running code.
2. **Discards local `bun.lock` drift** with `git checkout -- bun.lock`. `bun install` writes it again.
3. **Switches the channel** when it must: onto the dev branch for `tools update dev`, or back to the branch you came
   from when a dev channel record exists. See [Dev channel](#dev-channel).
4. **Pulls** with `git pull` on the current branch. Right after a switch to the dev branch there is nothing to pull,
   so this step is skipped. A failed pull goes to [recovery](#when-git-pull-fails).
5. **Installs dependencies** with `bun install`. When that fails, it deletes `node_modules` and tries once more. A
   second failure stops the update with exit code 1.

Then it starts a child `tools update` with `GENESIS_TOOLS_UPDATE_POST_PULL=1`. The child runs the `tools` of the
checkout that started the update, so the remaining steps run the pulled code only when that checkout is the one being
updated. Before this handoff existed, those steps ran the code loaded before the pull, so every fix
to them reached a user one update late. The child gets `--no-plugins` when you passed it, and the first process
exits with the child's exit code. When the pulled code predates the handoff (you switched to an older branch), the
current updater finishes the steps itself and prints a compatibility notice. It does not start the older command,
which would not understand `--no-plugins`.

The child does the rest:

6. **Keeps GenesisTools.app current** (macOS only). It rebuilds an installed app whose sources changed. It never
   installs the app for someone who has none: building it is opt-in in `install.sh` (#445). See
   [GenesisTools.app](#genesistoolsapp).
7. **Offers to restart stale services.** It asks `tools services list --json` which servers (daemons, gateways,
   dashboards) still run code from before the update, and offers `tools services restart --stale`. Agent sessions
   are never listed there, so this cannot restart one.
8. **Refreshes the Claude Code plugin.** See [Claude Code plugin step](#claude-code-plugin-step).
9. **Offers the genesis-tools MCP server** when it is not registered with Claude Code. Registration is never
   automatic. When Claude Code has no config file yet, it only says to start Claude Code once and register later.
10. **Prints a short summary.** It prints `GenesisTools updated successfully!`, then only what changed since the last
    run: the version, added, removed or changed commands, and added, removed or changed skills. With no change it
    prints "No catalogue changes since the last update". The full changelog entry and the full lists of tools and
    skills need verbose mode.

#### Prompts

| Step           | In a terminal          | Without a terminal (agent, CI)      |
| -------------- | ---------------------- | ----------------------------------- |
| Plugin step    | asks, default yes      | runs without asking                 |
| Stale services | asks, default no       | prints the restart command          |
| MCP server     | asks, default no       | prints the register command         |

"A terminal" means stdin is a TTY. Answer **No** to the plugin question to skip the plugin step for this run.
Cancelling that question (Ctrl-C) ends the whole update with exit code 0, so the MCP offer and the summary do not
run either.

### Dev channel

```bash
tools update dev   # onto the newest origin/feat/<date>-enhancements-unified
tools update       # back to the branch you came from, then a normal pull
```

`tools update dev` fetches `origin` (with `--prune`), picks the `feat/<YYYY-MM-DD>-enhancements-unified` branch with
the newest date in its name, and runs `git switch --track -C <branch> origin/<branch>`. That resets a local branch
of the same name onto origin's tip.

It refuses to switch when:

- the checkout has uncommitted changes to tracked files (untracked files do not count);
- a local copy of the dev branch has commits that origin does not have;
- origin has no such branch, or `git fetch` fails.

The branch you came from is kept per checkout in
`~/.genesis-tools/update/dev-channels/<checkout-hash>.json`, where the hash is the SHA-256 of the checkout's real
path. A linked worktree therefore has its own record. The record holds `checkout`, `branch` (the dev branch),
`returnTo` and `since` (an ISO time).

- On the first switch, the return branch is the branch you were on. When you were already on an
  enhancements-unified branch by hand, or on no branch, it is `master`, so the next plain update does leave the dev
  channel.
- Running `tools update dev` again moves you to the newest dev branch and keeps the first return branch.
- The next plain `tools update` needs a clean tracked tree, runs `git switch <returnTo>`, deletes the record, and
  pulls. When the switch fails, the record stays, so you can fix the cause and run it again.
- Without a record for this checkout, a plain update stays on its current branch, whatever branch that is.

### When `git pull` fails

The common cause is an upstream that was rewritten or force-pushed. On a test repository where only the last two
commits were rewritten, a plain `git pull` (merge) exited 1 with conflicts, `--rebase` exited 0, and `--ff-only`
exited 128. So the update does not retry the pull. It takes one recovery path:

1. Aborts a half-finished merge or rebase that the failed pull left.
2. Runs `git fetch origin`. When that fails too, it stops: the cause is the network or authentication, not history.
3. Stashes all local changes, untracked files included (`git stash push --include-untracked`, message
   `tools update <time>`).
4. Saves local commits that the upstream does not have on a branch `tools-update-backup-<time>`, and prints the
   `git rebase --onto` command that replays them.
5. Runs `git reset --hard` onto the tracked upstream (`origin/master` when the branch tracks nothing).

The stash is never applied for you. The update prints how to find it (`git stash list`), how to apply it
(`git stash pop`), and what to do when the history was rewritten (`git stash branch rescue`).

When a step of the recovery fails, the update stops with exit code 1 and prints the manual route:

```bash
cd ~/Projects/GenesisTools   # your checkout; the update prints its real path
git stash push --include-untracked -m 'pre-update'
git fetch origin && git reset --hard origin/master
```

If that also fails, clone the repository again.

### Claude Code plugin step

The step needs the `claude` binary. The update looks on `PATH`, then in the Claude Code installers' own folders,
then in your interactive shell. When it finds none, it prints one line and skips the step.

This checkout is the plugin marketplace. When the checkout has `.claude-plugin/marketplace.json`, the update
registers the checkout folder itself as the `genesis-tools` marketplace (`claude plugin marketplace add <checkout>`).
A marketplace registered from the GitHub URL makes Claude Code clone a second copy into
`~/.claude/plugins/marketplaces/genesis-tools`, and then edits in the checkout take effect only after they are
committed and pushed.

| Case                                  | What the update does               |
| ------------------------------------- | ---------------------------------- |
| Checkout, marketplace points here     | Refreshes it                       |
| Checkout, marketplace missing/elsewhere | Registers this checkout          |
| No checkout, marketplace missing      | Registers the GitHub URL (below)   |
| No checkout, marketplace registered   | Refreshes it                       |
| `marketplace list` failed             | Leaves it alone, refreshes         |

The GitHub URL is `https://github.com/genesiscz/GenesisTools`. A failed listing is not treated as a missing
marketplace, because `marketplace add` overwrites a working registration.

Then, in order, and each only when the step before it worked:

1. `claude plugin marketplace update genesis-tools`. Claude Code caches each marketplace's parsed catalogue, so
   without this refresh the next command fails with `Plugin "genesis-tools" not found in marketplace`.
2. `claude plugin install genesis-tools@genesis-tools` when the plugin is not installed.
3. After a re-point: `claude plugin uninstall genesis-tools@genesis-tools --keep-data -y`, then `plugin install`.
   The plugin cache is keyed by version, so `plugin update` would keep the copy from the old source.
4. Otherwise: `claude plugin update genesis-tools@genesis-tools`.

A failed marketplace step leaves the installed plugin untouched. Inside an agent session (Claude Code, Codex, Grok
and others) the step ends with "Restart Claude Code to apply the new plugin version".

### GenesisTools.app

On macOS the update checks `~/Applications/GenesisTools.app`. When the app is installed and its sources changed since it
was last built (or it was built from another checkout), the update rebuilds, signs and swaps the bundle, with live
build progress. Privacy grants survive the rebuild because the signing identity stays the same. An ad-hoc signed
build is the exception: macOS forgets its grants, and the update says so.

The rebuild needs an SDK that can compile the app's SwiftUI:

- Full Xcode always works.
- With the Command Line Tools only (`xcode-select -p` is `/Library/Developer/CommandLineTools`), the update uses the
  newest installed SDK whose SwiftUI `@State` is still a plain property wrapper, such as the 26.5 SDK (#564). From
  the macOS 27 SDK on, `@State` is a macro, and its plugin ships only with Xcode.
- When no SDK passes, the update skips the rebuild with one hint and goes on.

A failed rebuild never fails the update: tools keep running under the previous bundle.

### Where data lives

- `~/.genesis-tools/update/dev-channels/<hash>.json`: the dev channel record, one per checkout.
- `~/.genesis-tools/update/catalogue-snapshot.json`: the tools and skills seen by the last run.
- `~/Applications/GenesisTools.app`: the app bundle that step 6 rebuilds.
- `~/.claude.json`: read to see if the MCP server is registered.
- `<checkout>/CHANGELOG.md`: its first `## ` heading is the version.

- The catalogue snapshot holds the version heading plus each tool's and skill's name and description. Tools come
  from `src/`, skills from `plugins/genesis-tools/skills/*/SKILL.md`. A changed description counts as "changed".
  The first run only records the baseline and reports no changes. Every run, verbose or not, writes a new snapshot. A
  verbose run (`DEBUG=1`) prints the full lists instead of the
  change lines, and its snapshot still advances, so that run's changes are never reported again.
  An unreadable snapshot counts as a first run.
- The update calls `git`, `bun install`, the `claude` CLI and `tools services`. When you accept the MCP offer, it
  registers the server with the same code as `tools genesis-tools-mcp install`. It needs the network for the git
  remote, the package registry and (for a GitHub marketplace) GitHub. Nothing it does costs money.
- On Linux and other non-macOS systems the app step is skipped.

## Configuration

There is no config file. These environment variables change what it does:

- `GENESIS_TOOLS_PATH`: the checkout to update (set by `install.sh`).
- `GENESIS_TOOLS_HOME`: moves the `~/.genesis-tools` data root (tests use it).
- `GENESIS_TOOLS_CODESIGN_IDENTITY`: the codesign identity for the app rebuild.
- `DEBUG=1`: counts as one `-v`, and reaches the post-pull steps.
- `GENESIS_TOOLS_UPDATE_POST_PULL`: internal. `1` runs only steps 6 to 10, with no pull or install.

## For agents

- No step waits on a prompt without a TTY. An agent's stdin is not a terminal, so the plugin step runs, and the
  service restart and the MCP offer only print their commands. On 2026-10-25 an update hung under an agent on a
  plugin prompt; that is why the step now decides by itself.
- Pass `--no-plugins` when the agent must not change the Claude Code plugin. After a plugin change inside Claude
  Code, the new plugin version loads only after a restart of Claude Code.
- There is no `--json` output, no MCP tool and no plugin skill for this tool.
- Exit codes: 0 when the update finished (also when the app rebuild, the plugin step or the MCP registration failed,
  which only print a warning). 1 when the channel switch failed, the pull could not be recovered, or `bun install`
  failed twice.

## Troubleshooting

- **`--verbose` prints no changelog and no full lists.** The child that runs the post-pull steps starts as
  `tools update` with only `--no-plugins` forwarded, so it never sees `-v`. Run `DEBUG=1 tools update` instead:
  the child inherits `DEBUG`, which counts as one `-v`. A verbose run hides the version, command and skill changes for
  good: it prints the full lists and still writes the new snapshot.
- **`./tools update` in a linked worktree updates another checkout.** `GENESIS_TOOLS_PATH` wins over the checkout
  that runs the code, and it normally names the main checkout. It pulls and installs the main checkout, but steps 6
  to 10 run the worktree's code, and the app step rebuilds GenesisTools.app from the worktree's Swift sources.
  `GENESIS_TOOLS_PATH="$PWD" ./tools update` updates the worktree, does the same app rebuild, and also re-points the
  Claude Code marketplace at the worktree, so a later removal of the worktree leaves it pointing at a missing folder.
  Add `--no-plugins`, or run the update from the main checkout.
- **"The GenesisTools checkout has uncommitted changes".** The channel switch refuses tracked changes. Commit or
  stash them, then run the command again.
- **"`<branch>` has N local commit(s) that are not on origin".** `tools update dev` would reset that local branch.
  Push the commits or move them to another branch first.
- **"`<path>` is unreadable or invalid JSON" or "has invalid channel state".** The dev channel record is damaged.
  Move the file aside and switch the checkout to the branch you want by hand.
- **"`<path>` belongs to another checkout".** The record names a different checkout path. Move it aside.
- **"git fetch also failed".** The pull failed for a network or authentication reason. Fix access to the remote and
  run the update again.
- **"Skipped rebuilding GenesisTools.app: no installed SDK can build it without Xcode".** Install Xcode, select it
  with `sudo xcode-select -s /Applications/Xcode.app`, then run `tools macos permissions build`.
- **"Claude Code CLI not found; skipping the plugin steps".** Install Claude Code, then run `tools update` again.
- **"Plugin reinstall failed after uninstall".** Run `claude plugin install genesis-tools@genesis-tools`.
- **"This version predates the update handoff".** Expected when the pull lands on older code. The current updater
  finishes the run.

## Related

- [`tools services`](../services/README.md): lists and restarts the servers that step 7 finds on old code.
- [`tools genesis-tools-mcp`](../genesis-tools-mcp/README.md): `install` registers the MCP server that step 9 offers.
- [`tools macos`](../macos/README.md): `permissions build` builds GenesisTools.app by hand.

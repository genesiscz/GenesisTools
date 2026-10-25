# Update

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Update GenesisTools to the latest version.**

`git pull`s the GenesisTools repo, re-runs `bun install` (with a clean `node_modules` retry on failure), and optionally re-installs / updates the Claude Code plugin from the marketplace.

---

## Quick Start

```bash
tools update
```

The tool discovers the GenesisTools install path from `$GENESIS_TOOLS_PATH` or the directory of the running `tools` binary.

---

## Dev channel

```bash
tools update dev      # switch to the newest origin/feat/<date>-enhancements-unified branch
tools update          # the next plain update switches back to the branch you came from, then pulls
```

The branch you came from is kept in `~/.genesis-tools/update/dev-channel.json`. Without that file a plain update stays on its current branch. The switch refuses uncommitted tracked changes, and it refuses a local copy of the dev branch that has commits origin does not have.

## What it does

1. `git checkout -- bun.lock` to discard local lockfile drift.
2. `git pull` in the GenesisTools repo.
3. `bun install` — retries once with a clean `node_modules` if the first attempt fails.
   Everything after this step runs in a child `tools update` on the code the pull just brought in (`GENESIS_TOOLS_UPDATE_POST_PULL=1`). Before this, the steps ran the code loaded before the pull, so every fix to them reached a user one update late.
4. Refreshes the Claude Code plugin. A terminal gets asked first; without one (an agent, CI) the step runs without asking, and `--no-plugins` skips it:
   - Inside a Claude Code session: runs `claude plugin marketplace update` and `claude plugin update`.
   - Outside: runs `marketplace add`, `marketplace update`, then `plugin install genesis-tools@genesis-tools`.

Cancel the Claude step, or pass `--no-plugins`, if you only want the source update.

An installed GenesisTools.app whose sources changed is rebuilt only with full Xcode. With the Command Line Tools only (`xcode-select -p` is `/Library/Developer/CommandLineTools`) the rebuild is skipped with a hint, because the SwiftUI macro plugins ship only with Xcode.

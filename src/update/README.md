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

## What it does

1. `git checkout -- bun.lock` to discard local lockfile drift.
2. `git pull` in the GenesisTools repo.
3. `bun install` — retries once with a clean `node_modules` if the first attempt fails.
4. Prompts to refresh the Claude Code plugin:
   - Inside a Claude Code session: runs `claude plugin marketplace update` and `claude plugin update`.
   - Outside: runs `marketplace add`, `marketplace update`, then `plugin install genesis-tools@genesis-tools`.

Cancel the Claude step if you only want the source update.

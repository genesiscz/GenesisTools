---
name: setup
description: Set up GenesisTools to make the "tools" command function globally
argument-hint: "[optional: setup details]"
allowed-tools:
  - Bash
---

# Setup GenesisTools

Help the user set up GenesisTools on their system by running the install.sh script.

## What This Does

GenesisTools is a TypeScript-based CLI toolkit that provides powerful utilities for development tasks. The setup process:

1. **Installs dependencies** - Runs `bun install` to install npm packages
2. **Makes `tools` global** - Adds GenesisTools to PATH via shell config modification (.zshrc, .bashrc, etc.)
3. **Enables tool discovery** - Allows `tools` command to work from any directory

## Available Tools After Setup

- `git-last-commits-diff` - Show diffs of recent commits
- `collect-files-for-ai` - Gather files for LLM context
- `files-to-prompt` - Convert files to prompt format
- `watch` - Monitor file changes
- `npm-package-diff` - Compare npm package versions
- And more (run `tools` to see full list)

## System Requirements

Before proceeding, ensure the user has:
- **Bun** installed (https://bun.sh)
- **Node.js 18+**
- **UNIX-like system** (macOS, Linux, WSL)
- **Git** (to clone the repo)

## Setup Instructions

Guide the user through these steps:

1. Navigate to the GenesisTools directory
2. Run the installation script:
   ```bash
   ./install.sh
   ```
3. The script will:
   - Install dependencies
   - Modify their shell configuration
   - Provide instructions to reload their shell
4. Reload shell config (usually: `source ~/.zshrc` or `source ~/.bashrc`)
5. Verify setup: Run `tools` command (should show interactive tool selector)

## After Setup

Once complete, the user can:
- Run `tools` to see all available commands
- Run `tools <tool-name>` to execute a specific tool
- Run `tools <tool-name> --help` to get help for any tool

## Troubleshooting

If `tools` command is not found:
1. Verify shell config was reloaded: `source ~/.zshrc` or `source ~/.bashrc`
2. Check install.sh executed without errors
3. Verify Bun is installed: `bun --version`
4. Check GenesisTools is in PATH: `echo $PATH | grep -i genesis`

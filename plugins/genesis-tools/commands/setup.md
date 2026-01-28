---
name: genesis-tools:setup
description: Set up GenesisTools to make the "tools" command function globally
argument-hint: "[optional: setup details]"
allowed-tools:
    - Bash
    - AskUserQuestion
---

# Setup GenesisTools

Help the user set up GenesisTools on their system.

## Important: Plugin vs Full Installation

The genesis-tools Claude Code plugin provides skills and commands, but **the full GenesisTools repository must be cloned** to use the `tools` CLI globally.

## Setup Workflow

### Step 1: Check if Already Installed

First, check if GenesisTools is already installed:

```bash
which tools || echo "NOT_FOUND"
```

If `tools` is found and works, setup is complete. Show available tools with `tools --help`.

### Step 2: Check Prerequisites

Verify Bun is installed:
```bash
bun --version
```

If Bun is not installed, tell the user:
```
Bun is required. Install it with:
  curl -fsSL https://bun.sh/install | bash
```

Then have them restart their terminal and run `/genesis-tools:setup` again.

### Step 3: Ask Where to Clone

**Use AskUserQuestion** to ask where to clone the repository:

- **Question:** "Where should I clone GenesisTools?"
- **Recommended option:** `$HOME/GenesisTools` (explain this is the recommended location)
- **Other option:** Let user specify custom path

Explain: "The full repository needs to be cloned to enable the global `tools` command. The plugin alone doesn't include the CLI tools."

### Step 4: Clone and Install

Once user confirms location (e.g., `$HOME/GenesisTools`):

```bash
# Clone the repository
git clone https://github.com/genesiscz/GenesisTools.git $HOME/GenesisTools

# Enter directory and run installation
cd $HOME/GenesisTools && ./install.sh
```

Wait for the script to complete. It will:
- Install npm dependencies with `bun install`
- Add GenesisTools to PATH in `.zshrc` and `.bashrc`

### Step 5: Verify and Explain

After installation completes:

1. Tell user to reload shell: `source ~/.zshrc` or `source ~/.bashrc`
2. Verify with: `tools --help`

Explain what's now available:
- `tools` - Interactive tool selector (run without arguments)
- `tools github` - GitHub issue/PR fetching and search
- `tools collect-files-for-ai` - Gather files for AI context
- `tools git-last-commits-diff` - Show recent commit diffs
- `tools watch` - Monitor file changes
- `tools files-to-prompt` - Convert files to prompt format
- And more! Run `tools` to see the full list.

## Troubleshooting

If `tools` command is not found after installation:
1. Reload shell config: `source ~/.zshrc` or `source ~/.bashrc`
2. Check PATH: `echo $PATH | grep -i genesis`
3. Verify clone location exists and contains `tools` file
4. Re-run install: `cd ~/GenesisTools && ./install.sh`

## Install Session Tracking Hook (Optional)

To enable file tracking for "commit only Claude's changes", merge the hooks from the plugin's `hooks/hooks.json` into `~/.claude/settings.json`.

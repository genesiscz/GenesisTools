# 🔄 Rename Commits

> Interactively rename commit messages for the last N commits with a beautiful confirmation screen before rewriting history.

A powerful tool that helps you clean up your git commit history by renaming commit messages interactively. Perfect for fixing typos, improving clarity, or standardizing commit message formats before pushing.

---

## ✨ Features

-   🎯 **Interactive prompts** - See old commit messages and provide new ones one-by-one
-   📋 **Confirmation screen** - Review all changes (old → new) before applying
-   🔄 **Automatic rebase** - Uses git rebase to rewrite commit history
-   ⚠️ **Safety warnings** - Reminds you about history rewriting
-   🧹 **Clean implementation** - No separate script files needed, uses inline bash commands

---

## 🚀 Quick Start

```bash
# Rename last 3 commits
tools rename-commits --commits 3

# Or interactively (will prompt for number)
tools rename-commits
```

---

## 📋 Usage

### Basic Usage

```bash
# Rename last 5 commits
tools rename-commits -c 5

# Interactive mode (prompts for number of commits)
tools rename-commits
```

### Workflow

1. **Specify number of commits** - Either via `-c` flag or interactively
2. **Review commits** - See the last N commits with their current messages
3. **Rename each commit** - For each commit (oldest first), you'll be prompted with:
    - Commit hash (short)
    - Current commit message (as default)
    - Input field for new message
4. **Confirm changes** - See a summary of all changes:

    ```
    OLD: Fix typo in README
    NEW: Fix typo in README.md

    OLD: Add feature
    NEW: Add user authentication feature
    ```

5. **Apply changes** - Git rebase rewrites the commit history

---

## ⚙️ Options

| Option          | Alias | Description                        |
| --------------- | ----- | ---------------------------------- |
| `--commits, -c` |       | Number of recent commits to rename |
| `--help, -h`    |       | Show help message                  |

---

## ⚠️ Important Notes

### History Rewriting

This tool uses `git rebase -i` to rewrite commit history. This means:

-   ⚠️ **Don't use on pushed commits** - Only rename commits that haven't been pushed yet
-   🔄 **Changes commit hashes** - All commits after the renamed ones will get new hashes
-   💾 **Backup recommended** - Consider creating a backup branch before renaming

### How It Works

1. Fetches the last N commits from your current branch
2. Prompts you for new messages (oldest commit first)
3. Uses `git rebase -i` with custom editors:
    - `GIT_SEQUENCE_EDITOR`: Changes all `pick` to `reword`
    - `GIT_EDITOR`: Sets commit messages from your input
4. Cleans up temporary files automatically

---

## 🎯 Examples

```bash
# Rename last 3 commits
tools rename-commits -c 3

# Interactive mode - will ask how many commits
tools rename-commits

# Show help
tools rename-commits --help
```

---

## 💡 Tips

-   **Start small** - Test with 1-2 commits first to get familiar
-   **Be descriptive** - Use the opportunity to improve commit message clarity
-   **Check before pushing** - Review your git log after renaming to ensure everything looks good
-   **Use conventional commits** - Consider standardizing to formats like `feat:`, `fix:`, `docs:`, etc.

---

## 🔧 Technical Details

-   Uses `git rebase -i HEAD~N` for history rewriting
-   Stores commit messages temporarily in `/tmp/genesis-tools-msgs-{timestamp}/`
-   Uses inline bash commands via `sh -c` (no separate script files)
-   Works from any directory (uses absolute paths)

---

## 🐛 Troubleshooting

### Rebase Conflicts

If you encounter conflicts during rebase:

1. The rebase will pause
2. Resolve conflicts manually
3. Continue with `git rebase --continue`
4. Or abort with `git rebase --abort`

### Operation Cancelled

You can cancel at any time:

-   During commit count prompt: `Ctrl+C`
-   During message prompts: `Ctrl+C`
-   During confirmation: Select "No"

The tool will exit cleanly without making any changes.

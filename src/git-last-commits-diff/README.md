# Git Last Commits Diff

![Git](https://img.shields.io/badge/Git-F05032?style=flat-square&logo=git&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)

> **Generate diffs between commits with interactive selection and flexible output options**

Extract git diffs between any commit and HEAD, with searchable commit history, auto-generated filenames, and multiple output modes.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Interactive Selection** | Searchable list of last 200 commits |
| **Flexible Range** | Specify commit count or select individual commit |
| **Smart Filenames** | Auto-generated: `commits-{sha}-{sha}.diff` |
| **Multiple Outputs** | File, clipboard, or stdout |
| **Path to Clipboard** | File path auto-copied when saving |
| **Rich Context** | 15 lines of context, rename detection |

---

## Quick Start

```bash
# Interactive commit selection
tools git-last-commits-diff .

# Diff last 5 commits
tools git-last-commits-diff . --commits 5

# Copy diff to clipboard
tools git-last-commits-diff . -c 3 --clipboard

# Save to specific file
tools git-last-commits-diff /path/to/repo -c 10 --output changes.diff
```

---

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `[directory]` | - | Path to Git repository | required |
| `--commits` | `-c` | Number of commits to diff (HEAD~N..HEAD) | interactive selection |
| `--output` | `-o` | Output file path | interactive selection |
| `--clipboard` | - | Copy diff to clipboard | `false` |
| `--help-full` | `-?` | Show help message | - |

---

## Output Modes

### File Output
```bash
# Specify filename
tools git-last-commits-diff . -c 5 -o my-changes.diff

# Interactive filename prompt (auto-suggests commits-{sha}-{sha}.diff)
tools git-last-commits-diff .
# Select "Save to a file" → prompted for filename
```

When saving to a file, the absolute path is automatically copied to your clipboard.

### Clipboard Output
```bash
tools git-last-commits-diff . -c 3 --clipboard
```

### Stdout Output
```bash
# Pipe to other tools
tools git-last-commits-diff . -c 5 -o "" | head -100

# Flag without value outputs to stdout
tools git-last-commits-diff . -c 5 -o
```

---

## Usage Examples

<details>
<summary><b>Common Use Cases</b></summary>

### Review Recent Changes
```bash
# What changed in the last 3 commits?
tools git-last-commits-diff . -c 3 --clipboard
```

### Create Patch File
```bash
# Generate diff for code review
tools git-last-commits-diff . -c 10 -o review.diff
```

### Compare Feature Branch Work
```bash
# Interactive: select the commit where feature started
tools git-last-commits-diff /path/to/repo
# Search for the base commit, diff is generated to HEAD
```

### Quick AI Context
```bash
# Copy recent changes for AI review
tools git-last-commits-diff . -c 5 --clipboard
# Paste into Claude/ChatGPT for code review
```

</details>

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  1. Parse arguments (directory, commit count, output mode)  │
├─────────────────────────────────────────────────────────────┤
│  2. If no --commits: show searchable list of 200 commits    │
├─────────────────────────────────────────────────────────────┤
│  3. Run: git diff <ref> HEAD -M --unified=15 --no-color     │
├─────────────────────────────────────────────────────────────┤
│  4. Output to file/clipboard/stdout based on selection      │
└─────────────────────────────────────────────────────────────┘
```

**Git diff flags used:**
- `-M` - Detect file renames
- `--unified=15` - Show 15 lines of context
- `--ignore-space-at-eol` - Ignore trailing whitespace
- `--no-color` - Clean output for file/clipboard

---

## Interactive Flow

When run without `--commits`, you get an interactive experience:

```
ℹ --commits flag not provided. Attempting to list recent commits for selection.

? Select a commit (type to filter). The diff will be from this commit to HEAD:
❯ abc1234 - feat: add new feature
  def5678 - fix: resolve bug in parser
  ghi9012 - refactor: clean up utils
  ...

? Where would you like the diff output to go?
❯ Save to a file (path copied to clipboard)
  Copy to clipboard
  Print to stdout (console)

? Enter filename for the diff (will be created in /current/dir):
  commits-abc1234-xyz9999.diff
```

---

## Important Notes

> **Quote your paths**: If your repository path contains spaces, wrap it in quotes:
> ```bash
> tools git-last-commits-diff "/path/with spaces/repo"
> ```

> **Current directory**: Use `.` for the current directory:
> ```bash
> cd my-repo && tools git-last-commits-diff .
> ```

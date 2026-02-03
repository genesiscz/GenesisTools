# 📂 Collect Files for AI

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Git](https://img.shields.io/badge/Git-F05032?style=flat-square&logo=git&logoColor=white)
![AI](https://img.shields.io/badge/AI_Context-Ready-blueviolet?style=flat-square)

> **Quickly gather changed files from Git into a timestamped folder for AI context sharing**

Extract files from commits, staging area, or working directory and copy them to an organized output folder - perfect for providing focused context to AI assistants.

---

## ✨ Features at a Glance

| Feature | Description |
|---------|-------------|
| 🎯 **4 Collection Modes** | Commits, staged, unstaged, or all uncommitted files |
| 📅 **Timestamped Output** | Auto-generated folders like `.ai/2024-01-15-14.30` |
| 📁 **Structure Preservation** | Maintains directory hierarchy by default |
| ⚡ **Flat Mode** | Option to flatten all files to single directory |
| 🔍 **Smart Defaults** | Collects all uncommitted files when no mode specified |
| ✅ **Git Validation** | Verifies repository before processing |

---

## 🚀 Quick Start

```bash
# Collect all uncommitted files (default)
tools collect-files-for-ai

# Collect files from last 3 commits
tools collect-files-for-ai -c 3

# Collect only staged files
tools collect-files-for-ai --staged

# Collect from another repo with custom output
tools collect-files-for-ai ~/projects/myrepo -t ./context-files
```

---

## 📋 Options Reference

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `[directory]` | - | Path to Git repository | `.` (current dir) |
| `--commits` | `-c` | Collect files from last N commits | - |
| `--staged` | `-s` | Collect only staged files | - |
| `--unstaged` | `-u` | Collect only unstaged files | - |
| `--all` | `-a` | Collect all uncommitted files | `true` (default) |
| `--target` | `-t` | Output directory | `.ai/YYYY-MM-DD-HH.mm` |
| `--flat` | `-f` | Flatten directory structure | `false` |

> **Note:** Options `--commits`, `--staged`, `--unstaged`, and `--all` are mutually exclusive.

---

## 📖 Collection Modes

### 🔢 **Commits Mode** (`-c <number>`)
Collects files changed across the last N commits:
```bash
tools collect-files-for-ai -c 5
# Files changed in HEAD~5..HEAD
```

### 📤 **Staged Mode** (`-s`)
Collects only files in the staging area:
```bash
tools collect-files-for-ai --staged
# Ready for commit files only
```

### 📝 **Unstaged Mode** (`-u`)
Collects only modified tracked files not yet staged:
```bash
tools collect-files-for-ai --unstaged
# Working directory changes only
```

### 📦 **All Mode** (`-a`, default)
Collects all uncommitted changes (staged + unstaged):
```bash
tools collect-files-for-ai
# Everything different from HEAD
```

---

## 💡 Real-World Examples

<details>
<summary><b>🤖 AI Context Preparation</b></summary>

### Prepare Context for Code Review
```bash
# Collect your feature branch changes
tools collect-files-for-ai -c 10 -t ./ai-context

# Then share the folder with AI assistant
```

### Quick Bug Fix Context
```bash
# Collect just what you're working on
tools collect-files-for-ai --staged --flat -t ./bugfix-context
```

### Full Feature Snapshot
```bash
# All uncommitted work in timestamped folder
tools collect-files-for-ai
# Output: .ai/2024-01-15-14.30/
```

</details>

<details>
<summary><b>📁 Output Structure Examples</b></summary>

### Default (Preserves Structure)
```
.ai/2024-01-15-14.30/
├── src/
│   ├── components/
│   │   └── Button.tsx
│   └── utils/
│       └── helpers.ts
└── tests/
    └── Button.test.tsx
```

### Flat Mode (`--flat`)
```
.ai/2024-01-15-14.30/
├── Button.tsx
├── helpers.ts
└── Button.test.tsx
```

> **Warning:** Flat mode may overwrite files with identical names from different directories.

</details>

---

## 🎨 Output Format

The tool provides clear progress feedback:

```
✔ Found 5 file(s) to copy.
⏳ Copying files to .ai/2024-01-15-14.30...
  → Copied: src/components/Button.tsx
  → Copied: src/utils/helpers.ts
  → Copied: tests/Button.test.tsx

--- Summary ---
Total files found: 5
Successfully copied: 5
Copying errors: 0
✔ File collection completed successfully.
```

---

## ⚠️ Important Notes

> **Git Repository Required**: The tool validates that the target directory is a valid Git repository before processing.

> **File Existence**: Only existing files are copied. If a file was deleted in a commit, it will show a copy error but won't fail the entire operation.

> **Target Directory**: If not specified, creates `.ai/YYYY-MM-DD-HH.mm` in the current working directory (not necessarily the repo directory).

---

## 🛠️ Technical Details

- Built with **Commander.js** for CLI argument parsing
- Uses **Bun.spawn** for Git command execution
- Uses **Bun.write** for efficient file copying
- Supports nested directory creation with `fs.mkdir({ recursive: true })`

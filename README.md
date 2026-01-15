# 🌟 GenesisTools

<div align="center">

  <a href="https://deepwiki.com/genesiscz/GenesisTools"><img src="https://img.shields.io/badge/DeepWiki-AI_Docs-blue?style=for-the-badge&logo=readthedocs&logoColor=white" alt="DeepWiki" /></a>
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="MIT License" />
  
  <h3>✨ A powerful collection of development utilities for the modern developer ✨</h3>
  
  <p>
    <strong>Simplify your workflow with tools for Git operations, AI file analysis, release notes generation, and more!</strong>
  </p>

</div>

---

## 📚 Table of Contents

-   [🎯 Claude Code Plugin](#-claude-code-plugin)
-   [🚀 Quick Start](#-quick-start)
-   [🛠️ Available Tools](#️-available-tools)
    -   [🔍 Git & Version Control](#-git--version-control)
    -   [🤖 AI & Analysis](#-ai--analysis)
    -   [📊 Monitoring & Watching](#-monitoring--watching)
    -   [📦 Package Management](#-package-management)
-   [💡 Tool Details](#-tool-details)

---

## 🎯 Claude Code Plugin

GenesisTools includes a Claude Code plugin with skills and commands to enhance your AI-assisted development workflow.

### Installation for Claude Code

```bash
# 1. Clone the repository
git clone https://github.com/genesiscz/GenesisTools.git
cd GenesisTools

# 2. Install the marketplace
# Add this repository as a marketplace in your Claude Code settings
# The marketplace file is located at: .claude-plugin/marketplace.json

# 3. The plugin includes:
# - Setup command: Guide you through GenesisTools installation
# - Azure DevOps skill: Fetch and manage work items, queries, and dashboards
```

### What's Included in the Plugin

| Component | Name | Description |
|-----------|------|-------------|
| **Command** | `setup` | Interactive setup guide for installing GenesisTools globally |
| **Skill** | `azure-devops` | Automatically helps with Azure DevOps work items and queries |

To use the plugin in Claude Code:
- Commands are invoked with `/genesis-tools:setup`
- Skills are automatically triggered when you ask about Azure DevOps work items

---

## 🚀 Quick Start

### Prerequisites

> 📌 **Important**: BunJS is required as some tools use Bun-specific APIs

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash
```

### Installation

```bash
cd ~
# Clone and install GenesisTools
git clone https://github.com/genesiscz/GenesisTools.git
cd GenesisTools

# Install dependencies and make tools globally available
bun install && ./install.sh

# Reload your shell configuration
source ~/.zshrc  # For Zsh users
source ~/.bashrc # For Bash users
```

### 🎯 First Command

```bash
# List all available tools
tools

# Pick a tool from the interactive list - it auto-copies to clipboard! 📋
```

---

## 🛠️ Available Tools

### 🔍 Git & Version Control

| Tool                                                   | Description                                     |
| ------------------------------------------------------ | ----------------------------------------------- |
| **[Git Commit](#11--git-commit)**                      | 🤖 AI-powered commit messages with auto-staging |
| **[Git Last Commits Diff](#1--git-last-commits-diff)** | 📝 View diffs between recent commits            |
| **[GitHub Release Notes](#3--github-release-notes)**   | 📋 Generate beautiful release notes             |
| **[Last Changes](#13--last-changes)**                  | 📅 Show uncommitted changes grouped by time     |
| **[Rename Commits](#18--rename-commits)**              | 🔄 Interactively rename commit messages         |
| **[Git Rebase Multiple](#21--git-rebase-multiple)**    | 🌳 Safe branch hierarchy rebasing with rollback |

### 🤖 AI & Analysis

| Tool                                                 | Description                                   |
| ---------------------------------------------------- | --------------------------------------------- |
| **[Collect Files for AI](#2--collect-files-for-ai)** | 🤖 Aggregate project files for AI analysis    |
| **[Files to Prompt](#8--files-to-prompt)**           | 💬 Convert files to AI-friendly prompts       |
| **[Hold-AI](#10--hold-ai-tool)**                     | ⏸️ Control AI responses via WebSocket         |
| **[JSON/TOON Converter](#19--jsontoon-converter)**   | 🔄 Convert JSON ↔ TOON for token optimization |
| **[MCP Ripgrep](#9--mcp-ripgrep)**                   | ⚡ Lightning-fast code search server          |
| **[MCP Web Reader](#12--mcp-web-reader)**            | 🌐 Fetch raw HTML or Markdown (Jina/local)    |
| **[MCP TSC](#15--mcp-tsc)**                          | 🔍 TypeScript diagnostics (CLI & MCP)         |
| **[MCP Manager](#17--mcp-manager)**                  | ⚙️ Cross-platform MCP configuration manager   |
| **[Azure DevOps](#20--azure-devops)**                | 🔷 Fetch and manage Azure DevOps work items   |

### 📊 Monitoring & Watching

| Tool                                          | Description                                     |
| --------------------------------------------- | ----------------------------------------------- |
| **[macOS ESLogger](#16--macos-eslogger)**     | 🔐 Monitor macOS Endpoint Security events       |
| **[Watchman](#5--watchman)**                  | 👁️ Monitor file changes with Facebook Watchman  |
| **[Watch](#6--watch-formerly-watch-glob)**    | 🔄 Real-time file monitoring with glob patterns |
| **[FSEvents Profile](#14--fsevents-profile)** | 📊 Profile macOS filesystem events              |

### 📦 Package Management

| Tool                                         | Description                              |
| -------------------------------------------- | ---------------------------------------- |
| **[NPM Package Diff](#7--npm-package-diff)** | 🎨 Beautiful package version comparisons |

---

## 💡 Tool Details

### 1. 📝 Git Last Commits Diff

> Display beautiful diffs between recent commits or working changes - perfect for AI input!

<details>
<summary><b>🎯 Quick Example</b></summary>

```bash
# Diff last 2 commits
tools git-last-commits-diff /path/to/repo --commits 2

# Interactive commit selection
tools git-last-commits-diff /path/to/repo

# Copy diff to clipboard
tools git-last-commits-diff . --commits 3 --clipboard
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option             | Description                          |
| ------------------ | ------------------------------------ |
| `<directory>`      | 📁 Path to Git repository (required) |
| `--commits, -c`    | 🔢 Number of recent commits to diff  |
| `--output, -o`     | 💾 Save diff to file                 |
| `--clipboard, -cl` | 📋 Copy diff to clipboard            |
| `--help, -h`       | ❓ Show help message                 |

</details>

---

### 2. 🤖 Collect Files for AI

> Smart file collection tool that gathers changed files for AI analysis with intelligent filtering.

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Collect files from last 5 commits
tools collect-files-for-ai ./my-repo -c 5

# Collect only staged files
tools collect-files-for-ai . --staged

# Collect with flat structure (no subdirectories)
tools collect-files-for-ai . --all --flat
```

</details>

<details>
<summary><b>⚙️ Modes & Options</b></summary>

**🎨 Collection Modes** (choose one):

-   `--commits, -c NUM` - Files from last NUM commits
-   `--staged, -s` - Only staged files
-   `--unstaged, -u` - Only unstaged files
-   `--all, -a` - All uncommitted files (default)

**📁 Output Options**:

-   `--target, -t DIR` - Custom output directory
-   `--flat, -f` - Copy files without preserving directory structure

</details>

---

### 3. 📋 GitHub Release Notes

> Generate beautiful, markdown-formatted release notes from any GitHub repository.

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Generate release notes
tools github-release-notes facebook/react releases.md

# From GitHub URL
tools github-release-notes https://github.com/microsoft/vscode releases.md

# Limit releases & sort oldest first
tools github-release-notes vercel/next.js notes.md --limit=10 --oldest
```

</details>

<details>
<summary><b>💡 Pro Tip</b></summary>

Set `GITHUB_TOKEN` environment variable to avoid rate limits:

```bash
export GITHUB_TOKEN=your_github_token
```

</details>

---

### 4. 🔢 T3Chat Length

> 🔒 **Internal Tool** - Analyzes T3Chat message lengths and thread sizes.

<details>
<summary><b>ℹ️ Note</b></summary>

This tool is for internal use. Modify `myInputJson` in `src/t3chat-length/index.ts` before running:

```bash
tools t3chat-length
```

</details>

---

### 5. 👁️ Watchman

> Monitor files using Facebook's Watchman for instant change detection.

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Watch current directory
tools watchman -c

# Watch specific directory
tools watchman /path/to/project

# Interactive directory selection
tools watchman
```

</details>

---

### 6. 🔄 Watch

> Real-time file monitoring with powerful glob patterns - like `tail -f` on steroids! 🚀

<details>
<summary><b>✨ Features</b></summary>

-   🎯 Watch files matching any glob pattern
-   📡 Real-time content updates
-   🆕 Auto-detect new files
-   🏠 Tilde expansion support (`~`)
-   ⚡ Configurable polling intervals
-   📊 Directory & file summaries

</details>

<details>
<summary><b>🎯 Examples</b></summary>

```bash
# Watch TypeScript files
tools watch "src/**/*.ts"

# Multiple file types with verbose mode
tools watch "~/projects/**/*.{js,ts,tsx}" -v -n 100

# Follow mode (like tail -f)
tools watch "logs/**/*.log" -f

# Fast polling with custom line count
tools watch "src/**/*" --seconds 1 -n 200
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option      | Alias | Description      | Default |
| ----------- | ----- | ---------------- | ------- |
| `--seconds` | `-s`  | Polling interval | `3`     |
| `--verbose` | `-v`  | Detailed logging | `false` |
| `--follow`  | `-f`  | Tail mode        | `false` |
| `--lines`   | `-n`  | Lines to display | `50`    |

</details>

---

### 7. 🎨 NPM Package Diff

> **🚀 Lightning-fast, beautiful diffs between NPM package versions**

A powerful command-line tool that creates temporary directories, installs package versions in parallel, watches for file changes during installation, and shows beautiful diffs with multiple output formats.

![Features](https://img.shields.io/badge/Features-12+-brightgreen?style=for-the-badge) ![Output Formats](https://img.shields.io/badge/Output_Formats-5-blue?style=for-the-badge) ![Performance](https://img.shields.io/badge/Performance-Parallel-orange?style=for-the-badge)

<details>
<summary><b>🌟 Key Features</b></summary>

**🎨 Visual Excellence**

-   Beautiful colored terminal diffs with syntax highlighting
-   Side-by-side and line-by-line comparisons
-   Interactive HTML reports with toggle views
-   Delta integration for GitHub-style diffs

**📊 Smart Analysis**

-   File size comparisons and statistics
-   Addition/deletion line counts
-   Glob pattern filtering (include/exclude)
-   Binary file detection and skipping

**⚡ Performance**

-   Parallel package installation
-   Efficient file watching during install
-   Configurable timeouts
-   Multi-package manager support (npm, yarn, pnpm, bun)

</details>

<details>
<summary><b>🎯 Examples</b></summary>

```bash
# Basic comparison
tools npm-package-diff react 18.0.0 18.2.0

# Compare all JavaScript files
tools npm-package-diff lodash 4.17.20 4.17.21 --filter="**/*.js"

# Generate a patch file
tools npm-package-diff express 4.17.0 4.18.0 --patch express.patch

# Create interactive HTML report
tools npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html

# Use delta for beautiful diffs
tools npm-package-diff typescript 4.9.0 5.0.0 --use-delta

# Compare with statistics
tools npm-package-diff webpack 4.46.0 5.88.0 --stats --sizes
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option           | Alias | Description                                             | Default     |
| ---------------- | ----- | ------------------------------------------------------- | ----------- |
| `--filter`       | `-f`  | Glob pattern to include files                           | `**/*.d.ts` |
| `--exclude`      | `-e`  | Glob pattern to exclude files                           | -           |
| `--output`       | `-o`  | Output file path                                        | console     |
| `--format`       | `-F`  | Output format (terminal/unified/html/json/side-by-side) | `terminal`  |
| `--patch`        | `-p`  | Generate patch file                                     | -           |
| `--verbose`      | `-v`  | Enable verbose logging                                  | `false`     |
| `--silent`       | `-s`  | Suppress output except errors                           | `false`     |
| `--stats`        | -     | Show statistics summary                                 | `false`     |
| `--sizes`        | -     | Compare file sizes                                      | `false`     |
| `--line-numbers` | -     | Show line numbers                                       | `true`      |
| `--word-diff`    | -     | Show word-level differences                             | `false`     |
| `--side-by-side` | -     | Side-by-side view                                       | `false`     |
| `--context`      | -     | Context lines in diff                                   | `3`         |
| `--use-delta`    | -     | Use delta for output                                    | `false`     |
| `--keep`         | `-k`  | Keep temporary directories                              | `false`     |

</details>

<details>
<summary><b>📋 Output Formats (`--format`)</b></summary>

-   **🖥️ terminal** - Colored diff with syntax highlighting (default)
-   **📄 unified** - Standard patch format for git apply
-   **🌐 html** - Interactive web page with toggle views
-   **📊 json** - Structured data for programmatic use
-   **↔️ side-by-side** - Split-screen terminal comparison

</details>

---

### 8. 💬 Files to Prompt

> Convert your codebase into AI-friendly prompts with intelligent formatting and filtering.

<details>
<summary><b>✨ Features</b></summary>

-   🎯 Multiple output formats (XML, Markdown, plain text)
-   📁 Recursive directory processing
-   🔍 Extension and pattern filtering
-   👻 Hidden file handling
-   📊 Line number support
-   🚫 Gitignore respect
-   📂 Flat folder structure copying with renamed files

</details>

<details>
<summary><b>🎯 Examples</b></summary>

```bash
# Basic usage
tools files-to-prompt src/components

# Filter by extensions
tools files-to-prompt -e js -e ts src/

# Generate markdown with line numbers
tools files-to-prompt --markdown -n -o output.md project/

# XML format for Claude
tools files-to-prompt --cxml src/ > prompt.xml

# Copy files to flat folder structure (renames files with directory structure)
tools files-to-prompt --flat-folder -o flat-output/ src/

# Flat folder with extension filtering
tools files-to-prompt --flat-folder -e js -e ts -o flat-js-ts/ project/

# Pipe from find command
find . -name "*.py" | tools files-to-prompt -0
```

</details>

---

### 9. ⚡ MCP Ripgrep

> Lightning-fast code search server implementing the Model Context Protocol (MCP).

<details>
<summary><b>🚀 Capabilities</b></summary>

-   **search** - Basic pattern search with highlighting
-   **advanced-search** - Extended options (word boundaries, symlinks, etc.)
-   **count-matches** - Count occurrences efficiently
-   **list-files** - List searchable files
-   **list-file-types** - Show supported file types

</details>

<details>
<summary><b>⚙️ MCP Configuration</b></summary>

Add to your MCP configuration file:

```json
{
    "mcpServers": {
        "ripgrep": {
            "command": "tools mcp-ripgrep",
            "args": ["--root", "/Root/Path/For/Project/"],
            "env": {}
        }
    }
}
```

</details>

---

### 10. ⏸️ Hold-AI Tool

> Control AI responses with a WebSocket-based hold/release mechanism.

<details>
<summary><b>🔧 How It Works</b></summary>

1. **Start Server** → Collects your messages
2. **AI Connects** → Via client tool
3. **You Provide Input** → Through editor interface
4. **Send "OK"** → Releases AI to continue

</details>

<details>
<summary><b>📝 Usage Flow</b></summary>

```bash
# Terminal 1: Start server
tools hold-ai/server

# Terminal 2: AI runs client
tools hold-ai/client

# Server: Opens editor for your input
# Type messages, save & exit to send
# Type "OK" alone to complete
```

</details>

---

### 12. 🌐 MCP Web Reader

> Fetches web content as raw HTML, Jina Reader Markdown, or locally extracted Markdown. Works as both CLI and MCP server.

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# CLI modes
tools mcp-web-reader --mode raw --url https://example.com
tools mcp-web-reader --mode markdown --depth advanced --url https://example.com
tools mcp-web-reader --mode jina --url https://example.com

# Token limiting and compaction
tools mcp-web-reader --mode markdown --url https://example.com --tokens 2048 --save-tokens
```

</details>

<details>
<summary><b>⚙️ MCP Tools</b></summary>

Exposed tools with parameters: `url`, `depth` (basic|advanced), `save_tokens` (0|1), `tokens` (max tokens)

-   `FetchWebRaw`
-   `FetchWebMarkdown`
-   `FetchJina`

Each returns `{ content: [{ type: "text", text }], meta: { tokens } }`.

</details>

---

### 13. 📅 Last Changes

> Shows uncommitted git changes grouped by modification time to help you understand what files were updated and when.

<details>
<summary><b>✨ Features</b></summary>

-   📅 Time-based grouping (Last hour, Last 3 hours, Today, Yesterday, etc.)
-   🎨 Color-coded git status (modified, added, deleted, renamed)
-   ⏰ Relative and absolute timestamps
-   📋 Detailed status descriptions (staged/unstaged)
-   🔍 Handles untracked files and directories

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Show uncommitted changes grouped by time
tools last-changes

# Enable verbose logging
tools last-changes --verbose
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option      | Alias | Description            |
| ----------- | ----- | ---------------------- |
| `--verbose` | `-v`  | Enable verbose logging |
| `--help`    | `-h`  | Show help message      |

</details>

<details>
<summary><b>📋 Output Format</b></summary>

Groups files by time periods:

-   **Last hour** - Files modified in the past hour
-   **Last 3 hours** - Files modified 1-3 hours ago
-   **Last 6 hours** - Files modified 3-6 hours ago
-   **Last 12 hours** - Files modified 6-12 hours ago
-   **Today** - Files modified today but more than 12 hours ago
-   **Yesterday** - Files modified yesterday
-   **Last N days** - Files modified in the past week
-   **Older** - Files modified more than a week ago

Each file shows:

-   Git status (M, A, D, R, etc.) with color coding
-   Status description (e.g., "modified (staged & unstaged)")
-   Relative time (e.g., "5 minutes ago")
-   Absolute timestamp (e.g., "Oct 30, 2024, 2:30:45 PM")

</details>

---

### 14. 📊 FSEvents Profile

> Profile file system events using macOS fsevents. Helps identify directories with high filesystem activity to diagnose performance issues or find cache/build directories.

<details>
<summary><b>✨ Features</b></summary>

-   📊 Monitor filesystem events in real-time
-   📈 Aggregate events by directory
-   🏆 Show top N most active directories
-   🔍 Find processes watching fsevents
-   ⚡ Uses native macOS fsevents API for efficiency

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Monitor entire filesystem for default 15 seconds
tools fsevents-profile

# Monitor specific directory
tools fsevents-profile /Users

# Monitor for custom duration
tools fsevents-profile -d 30

# Show top 5 directories instead of default 10
tools fsevents-profile -t 5 /tmp

# Show processes currently watching fsevents (requires root)
sudo tools fsevents-profile --watchers

# Enable verbose logging to see events in real-time
tools fsevents-profile -v /Users/Martin
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option       | Alias | Description                                             | Default |
| ------------ | ----- | ------------------------------------------------------- | ------- |
| `--duration` | `-d`  | Monitoring duration in seconds                          | `15`    |
| `--top`      | `-t`  | Number of top directories to display                    | `10`    |
| `--path`     | -     | Path to monitor                                         | `"/"`   |
| `--watchers` | `-w`  | Show processes currently watching fsevents (needs root) | -       |
| `--verbose`  | `-v`  | Enable verbose logging to see events as they occur      | -       |
| `--help`     | `-h`  | Show help message                                       | -       |

</details>

<details>
<summary><b>📋 How It Works</b></summary>

1. Starts an fsevents watcher on the specified path
2. Collects all file system events during the monitoring period
3. Aggregates events by parent directory
4. Displays the top N directories with the most activity
5. Press Ctrl+C at any time to stop early and see results

</details>

<details>
<summary><b>💡 Tips</b></summary>

-   Common high-activity locations include: caches, build outputs, cloud sync folders
-   Monitoring the root filesystem (`/`) may generate a large number of events
-   The `--watchers` flag requires root privileges to run `fs_usage`
-   Use `--verbose` to see events in real-time as they occur

</details>

---

### 16. 🔐 macOS ESLogger

> Monitor macOS Endpoint Security events in real-time using the ESLogger utility - perfect for security monitoring and debugging process execution!

**🚨 macOS Only** - Requires macOS 10.15+ and Full Disk Access permissions

<details>
<summary><b>✨ Features</b></summary>

-   🔍 **Real-time Event Monitoring**: Monitor system events as they happen
-   🎯 **Advanced Filtering**: Filter events using JSON path expressions
-   📊 **Multiple Event Types**: Process execution, file operations, authentication, and more
-   🏷️ **Event Categories**: Pre-defined groups like process, file, network, security
-   🎨 **Beautiful Output**: Color-coded, formatted event display
-   🔧 **Debug Mode**: Raw JSON output for troubleshooting
-   📝 **Multiple Output**: Console, file logging, or clipboard
-   🖥️ **Interactive Mode**: Easy setup for beginners

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Interactive mode (recommended for beginners)
tools macos-eslogger

# Monitor process events (exec, fork, exit)
tools macos-eslogger -c process

# Monitor specific events
tools macos-eslogger -e exec,fork,authentication

# Filter for specific processes
tools macos-eslogger -e exec --filter-event '.event.target.path =~ ".*bash.*"'

# Monitor file operations but exclude temp files
tools macos-eslogger -e open,write --filter-event '.event.file.path !~ ".*tmp.*"'

# Save authentication events to file
tools macos-eslogger -e authentication -o auth.log

# Debug mode to see raw event structure
tools macos-eslogger -e exec --debug --dry-run
```

</details>

<details>
<summary><b>⚙️ Event Categories</b></summary>

| Category   | Events                                     | Description                   |
| ---------- | ------------------------------------------ | ----------------------------- |
| `process`  | exec, fork, exit                           | Process lifecycle events      |
| `file`     | open, close, create, write, unlink, rename | File system operations        |
| `network`  | uipc_bind, uipc_connect                    | Network/socket operations     |
| `security` | authentication, sudo, su, setuid...        | Security and privilege events |
| `session`  | login/logout, screensharing, ssh           | User session events           |
| `auth`     | authorization events                       | System authorization          |

</details>

<details>
<summary><b>🔍 Filter Syntax</b></summary>

Use JSON path expressions with dot notation and regex operators:

```bash
# Regex matching (recommended)
.event.target.path =~ ".*bash.*"        # Executables containing "bash"
.event.target.path =~ "^/usr/.*"        # Paths starting with "/usr/"
.event.process.audit_token.pid == "1234" # Specific PID (exact match)

# Regex exclusion
.event.target.path !~ ".*tmp.*"         # Exclude temp file paths

# String matching (supports regex if pattern contains special chars)
.event.target.path == "/bin/bash"       # Exact string match
```

**Supported Operators:**

-   `==` - Exact match (supports regex if pattern contains `.*`)
-   `!=` - Not equal (supports regex if pattern contains `.*`)
-   `=~` - Regex match
-   `!~` - Regex not match

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option           | Alias | Description                                    |
| ---------------- | ----- | ---------------------------------------------- |
| `--events, -e`   |       | Comma-separated list of event types to monitor |
| `--category, -c` |       | Monitor all events in a category               |
| `--output, -o`   |       | Write output to file instead of stdout         |
| `--filter-event` |       | Filter events using JSON path expression       |
| `--include-fork` |       | Auto-include fork events when monitoring exec  |
| `--debug`        |       | Show raw JSON events for debugging             |
| `--dry-run`      |       | Show what would be monitored without running   |
| `--silent`       |       | Suppress non-error messages                    |
| `--verbose`      |       | Enable verbose logging                         |
| `--help, -h`     |       | Show help message                              |

</details>

<details>
<summary><b>🔧 Setup Requirements</b></summary>

**1. macOS Version:** 10.15+ (Catalina or later)

**2. Full Disk Access:** Required for ESLogger to work

```bash
# Go to: System Settings > Privacy & Security > Full Disk Access
# Add and enable: /usr/sbin/eslogger
```

**3. Run with sudo:** ESLogger requires root privileges

```bash
sudo tools macos-eslogger -e exec
```

**4. Terminal Session:** Run in a separate terminal from the one you're monitoring

</details>

<details>
<summary><b>📋 Understanding Events</b></summary>

**Process Events:**

-   **exec**: `event.target.path` - Executable being run
-   **fork**: `event.child.executable.path` - Child process created

**File Events:**

-   **open/write**: `event.file.path` - File being accessed
-   **create/unlink**: `event.target.path` - File being created/deleted

**Security Events:**

-   **authentication**: `event.success` - Auth success/failure
-   **sudo**: `event.command` - Command run with sudo

**Common Paths:**

-   `.event.target.path` - Executable path (exec events)
-   `.event.file.path` - File path (file events)
-   `.process.executable.path` - Process that triggered event
-   `.process.audit_token.pid` - Process ID

</details>

<details>
<summary><b>💡 Pro Tips</b></summary>

-   **Shell Builtins**: `which`, `cd`, `echo` don't trigger exec events - use `/usr/bin/which`
-   **Process Groups**: ESLogger suppresses events from its own process group
-   **Performance**: Start with specific events rather than all events
-   **Debugging**: Use `--debug` to see raw event structure for filter creation
-   **Categories**: Use `-c process` for general process monitoring

</details>

---

### 15. 🔍 MCP TSC

> TypeScript diagnostics checker that can run as both a CLI tool and an MCP server. It supports checking individual files, directories, or glob patterns against your project's tsconfig.json.

<details>
<summary><b>✨ Features</b></summary>

-   ✅ **CLI Mode**: Check TypeScript files from the command line
-   ✅ **MCP Server Mode**: Run as a persistent MCP server for AI assistants
-   ✅ **Dual Checking Methods**: Use TypeScript Compiler API or LSP
-   ✅ **Glob Pattern Support**: Check multiple files using patterns
-   ✅ **Persistent LSP**: In MCP mode, LSP stays running for faster checks

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Check a single file
tools mcp-tsc src/app.ts

# Check all TypeScript files in a directory
tools mcp-tsc src

# Check files using glob patterns (use quotes!)
tools mcp-tsc 'src/**/*.ts'

# Use LSP for checking (faster for incremental checks)
tools mcp-tsc --lsp src/app.ts

# Show warnings too
tools mcp-tsc --warnings src/app.ts

# Run as MCP server for current directory
tools mcp-tsc --mcp .

# Run MCP server for a specific project
tools mcp-tsc --mcp /path/to/project
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option       | Description                                            |
| ------------ | ------------------------------------------------------ |
| `--lsp`      | Use typescript-language-server instead of compiler API |
| `--warnings` | Show warnings in addition to errors                    |
| `--mcp`      | Run as MCP server (requires project path argument)     |

</details>

<details>
<summary><b>⚙️ MCP Configuration</b></summary>

Add to your MCP settings (e.g., Claude Desktop config):

```json
{
    "mcpServers": {
        "typescript-diagnostics": {
            "command": "/path/to/GenesisTools/tools",
            "args": ["mcp-tsc", "--mcp", "/path/to/your/project"]
        }
    }
}
```

</details>

<details>
<summary><b>⚙️ MCP Tool: GetTsDiagnostics</b></summary>

Get TypeScript diagnostics for files matching the specified patterns.

**Parameters:**

-   `files` (required): String or array of file paths/glob patterns
    -   Examples: `"src/app.ts"`, `"src/**/*.ts"`, `["file1.ts", "file2.ts"]`
-   `showWarnings` (optional): Include warnings in addition to errors (default: false)

**Example Requests:**

```typescript
// Single file
{ "files": "src/app.ts" }

// Glob pattern
{ "files": "src/**/*.ts" }

// Multiple files
{ "files": ["src/app.ts", "src/utils.ts"] }

// With warnings
{ "files": "src/app.ts", "showWarnings": true }
```

</details>

<details>
<summary><b>📋 Exit Codes</b></summary>

-   `0`: Success (no errors)
-   `1`: Usage error or no files found
-   `2`: TypeScript errors found

</details>

---

### 17. ⚙️ MCP Manager

> Cross-platform MCP (Model Context Protocol) server configuration manager. Manage MCP servers across multiple AI assistants (Claude Desktop, Gemini Code Assist, Codex, Cursor) with automatic backups, visual diffs, and safe operations.

<details>
<summary><b>✨ Features</b></summary>

-   🎯 **Multi-Provider Support**: Manage MCP servers for Claude, Gemini, Codex, and Cursor
-   📦 **Unified Configuration**: Single config file (`~/.genesis-tools/mcp-manager/config.json`) to manage all servers
-   💾 **Automatic Backups**: Creates backups before any changes with automatic restore on rejection
-   👁️ **Visual Diffs**: See exactly what changed before applying updates
-   ✅ **Interactive Confirmation**: Review changes and approve or revert
-   🔄 **Bidirectional Sync**: Sync servers from unified config to providers, or import from providers to unified config
-   🛡️ **Safe Operations**: All changes are reversible with automatic backup restoration

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Interactive mode - choose an action
tools mcp-manager

# Open/edit unified configuration file
tools mcp-manager config

# Sync servers from unified config to selected providers
tools mcp-manager sync

# Sync servers FROM providers TO unified config
tools mcp-manager sync-from-providers

# List all MCP servers across all providers
tools mcp-manager list

# Enable/disable servers
tools mcp-manager enable github
tools mcp-manager disable github

# Install a server from unified config to a provider
tools mcp-manager install github

# Show full configuration of a server
tools mcp-manager show github
```

</details>

<details>
<summary><b>⚙️ Commands</b></summary>

| Command               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `config`              | Open/create unified configuration file            |
| `sync`                | Sync MCP servers from unified config to providers |
| `sync-from-providers` | Sync servers FROM providers TO unified config     |
| `list`                | List all MCP servers across all providers         |
| `enable`              | Enable an MCP server in a provider                |
| `disable`             | Disable an MCP server in a provider               |
| `disable-all`         | Disable an MCP server for all projects (Claude)   |
| `install`             | Install/add an MCP server to a provider           |
| `show`                | Show full configuration of an MCP server          |

</details>

<details>
<summary><b>💡 Workflow</b></summary>

1. **Create Unified Config**: Edit unified config (`~/.genesis-tools/mcp-manager/config.json`) with all your MCP servers
2. **Sync Servers**:
    - Sync FROM unified config TO providers: `tools mcp-manager sync`
    - Sync FROM providers TO unified config: `tools mcp-manager sync-from-providers`
3. **Review Changes**: See diff and confirm or reject changes
4. **Automatic Backup**: If rejected, automatically restores from backup

</details>

<details>
<summary><b>🛡️ Safety Features</b></summary>

-   **Automatic Backups**: Created before every write operation
-   **Visual Diffs**: See exactly what will change
-   **Confirmation Prompts**: Approve or reject changes
-   **Automatic Restore**: Reverts changes if rejected

Backups are stored in `~/.mcp-manager/backups/` with timestamps.

</details>

<details>
<summary><b>📋 Supported Providers</b></summary>

-   **Claude Desktop**: `~/.claude.json` (supports global and project-specific configs)
-   **Gemini Code Assist**: `~/.gemini/settings.json`
-   **Codex**: `~/.codex/config.toml` (TOML format)
-   **Cursor**: `~/.cursor/mcp.json`

</details>

---

### 18. 🔄 Rename Commits

> Interactively rename commit messages for the last N commits with a beautiful confirmation screen before rewriting history.

<details>
<summary><b>✨ Features</b></summary>

-   🎯 Interactive prompts for each commit message
-   📋 Confirmation screen showing old → new mapping
-   🔄 Automatic git rebase to rewrite history
-   ⚠️ Safety warnings about history rewriting
-   🧹 Clean implementation with inline bash commands

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Rename last 3 commits
tools rename-commits --commits 3

# Interactive mode (prompts for number)
tools rename-commits

# Show help
tools rename-commits --help
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option          | Alias | Description                        |
| --------------- | ----- | ---------------------------------- |
| `--commits, -c` |       | Number of recent commits to rename |
| `--help, -h`    |       | Show help message                  |

</details>

<details>
<summary><b>⚠️ Important Notes</b></summary>

**History Rewriting:**

-   ⚠️ Only use on commits that haven't been pushed yet
-   🔄 Changes commit hashes for all renamed commits and their descendants
-   💾 Consider creating a backup branch before renaming

**Workflow:**

1. Specify number of commits (via `-c` or interactively)
2. Review commits and provide new messages one-by-one
3. Confirm changes in the summary screen
4. Git rebase rewrites the commit history

</details>

---

### 19. 🔄 JSON/TOON Converter

> Convert data between JSON and TOON (Token-Oriented Object Notation) formats. TOON can reduce token usage by 30-60% compared to standard JSON, making it ideal for LLM applications.

<details>
<summary><b>✨ Features</b></summary>

-   ✅ **Auto-Detection**: Automatically detects JSON or TOON format
-   ✅ **Bidirectional Conversion**: Convert JSON ↔ TOON seamlessly
-   ✅ **Size Comparison**: Compares TOON with compact JSON and returns the smaller format
-   ✅ **File & Stdin Support**: Works with files or piped input
-   ✅ **Verbose Mode**: Shows format detection, size comparison, and savings statistics
-   ✅ **Error Handling**: Clear, LLM-readable error messages

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Auto-detect format and convert (file)
tools json data.json
tools json data.toon

# Auto-detect format and convert (stdin)
cat data.json | tools json
echo '{"key":"value"}' | tools json

# Force conversion to TOON
tools json data.json --to-toon
cat data.json | tools json --to-toon

# Force conversion to JSON
tools json data.toon --to-json
cat data.toon | tools json --to-json

# Verbose mode (shows statistics)
tools json data.json --verbose
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option          | Alias | Description                                           |
| --------------- | ----- | ----------------------------------------------------- |
| `--to-toon, -t` |       | Force conversion to TOON format                       |
| `--to-json, -j` |       | Force conversion to JSON format                       |
| `--verbose, -v` |       | Enable verbose logging (shows format detection, etc.) |
| `--help, -h`    |       | Show help message                                     |

</details>

<details>
<summary><b>💡 How It Works</b></summary>

**Auto-Detection Mode:**

-   Detects input format (JSON or TOON)
-   Converts to the opposite format automatically
-   When converting JSON → TOON, compares sizes and returns the smaller format

**Forced Conversion Mode:**

-   Validates input format matches the requested conversion
-   Provides clear error messages if format doesn't match
-   Returns the converted result

**Size Comparison:**

-   Compares TOON output with compact JSON (no whitespace)
-   Returns the format with fewer bytes
-   Logs statistics in verbose mode

</details>

<details>
<summary><b>📋 Example Output</b></summary>

**JSON Input:**

```json
{
    "users": [
        { "id": 1, "name": "Alice", "role": "admin" },
        { "id": 2, "name": "Bob", "role": "user" }
    ]
}
```

**TOON Output:**

```
users[2]{id,name,role}:
  1,Alice,admin
  2,Bob,user
```

**Verbose Mode:**

```
Detected format: JSON
Compact JSON size: 86 bytes
TOON size: 52 bytes
✓ TOON is 39.5% smaller (34 bytes saved)
Returning TOON format
```

</details>

<details>
<summary><b>🎯 Use Cases</b></summary>

**For LLM Applications:**

-   Before sending data: Convert JSON to TOON to reduce token usage
-   After receiving data: Convert TOON responses back to JSON
-   In pipelines: Automatically optimize data format

**For Development:**

-   Format comparison: See which format is more compact
-   Data transformation: Convert between formats for different tools

</details>

---

### 20. 🔷 Azure DevOps

> Fetch, track, and manage Azure DevOps work items, queries, and dashboards with intelligent caching and change detection.

<details>
<summary><b>✨ Features</b></summary>

-   🔷 **Work Item Management**: Fetch individual work items with full details, comments, and relations
-   📊 **Query Support**: Run Azure DevOps queries with change detection between runs
-   📈 **Dashboard Integration**: Extract queries from dashboards automatically
-   💾 **Smart Caching**: 5-minute cache for work items, 180-day cache for queries
-   🔍 **Change Detection**: Automatically detects new items and updates (state, assignee, severity, title)
-   📁 **Task File Generation**: Saves work items as JSON and Markdown files
-   🗂️ **Category Organization**: Organize work items into categories (remembered per item)
-   📦 **Batch Operations**: Fetch multiple work items or download all items from a query
-   🎯 **Filtering**: Filter queries by state and severity
-   📄 **Multiple Output Formats**: AI-optimized, Markdown, or JSON output

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Configure for your project (first-time setup)
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"

# Fetch a work item
tools azure-devops --workitem 12345

# Fetch multiple work items
tools azure-devops --workitem 12345,12346,12347

# Fetch a query with change detection
tools azure-devops --query d6e14134-9d22-4cbb-b897-b1514f888667

# Filter query results by state
tools azure-devops --query <id> --state Active,Development

# Download all work items from a query
tools azure-devops --query <id> --download-workitems

# Organize into categories (remembered per work item)
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes

# Use task folders (each task in its own subfolder)
tools azure-devops --workitem 12345 --task-folders

# Get dashboard queries
tools azure-devops --dashboard <url|id>

# List all cached work items
tools azure-devops --list

# Force refresh (bypass cache)
tools azure-devops --workitem 12345 --force
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option                  | Alias | Description                                           | Default |
| ----------------------- | ----- | ----------------------------------------------------- | ------- |
| `--format <ai\|md\|json>` | -    | Output format                                        | `ai`    |
| `--force`, `--refresh`  | -    | Force refresh, ignore cache                          | -       |
| `--state <states>`      | -    | Filter by state (comma-separated)                    | -       |
| `--severity <sev>`      | -    | Filter by severity (comma-separated)                | -       |
| `--download-workitems`  | -    | With `--query`: download all work items to tasks/    | -       |
| `--category <name>`     | -    | Save to tasks/<category>/ (remembered per work item)  | -       |
| `--task-folders`        | -    | Save in tasks/<id>/ subfolder (only for new files)   | -       |
| `--help`                | `-h`  | Show help message                                     | -       |

</details>

<details>
<summary><b>🔧 First-Time Setup</b></summary>

**Prerequisites:**

1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
2. Install Azure DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Login with device code:
   ```bash
   az login --allow-no-subscriptions --use-device-code
   ```

**Configure:**

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
```

This auto-detects org, project, and projectId from the URL and saves to `.claude/azure/config.json`.

</details>

<details>
<summary><b>📋 Storage Structure</b></summary>

**Global Cache** (`~/.genesis-tools/azure-devops/cache/`):
- Query cache: 180 days TTL
- Work item cache: 5 minutes TTL
- Dashboard cache: 180 days TTL

**Project Storage** (`.claude/azure/`):
- `config.json` - Project configuration
- `tasks/` - Work item files (JSON + Markdown)
  - Flat: `{id}-{Slug-Title}.json`
  - With category: `{category}/{id}-{Slug-Title}.json`
  - With task folders: `{id}/{id}-{Slug-Title}.json`

Config search: Searches up to 3 parent levels from current directory.

</details>

<details>
<summary><b>💡 Key Features</b></summary>

**Change Detection:**
- Detects new work items added to queries
- Highlights changes to state, assignee, severity, title
- Shows before/after values in AI format

**Category Memory:**
- Categories are remembered per work item in global cache
- Future fetches automatically use the same category

**Task Folders:**
- Only applies to new files
- Existing files stay in their current location
- Prevents accidental reorganization

**Batch Download:**
- Download all work items from a query with one command
- Automatically fetches full details (comments, relations) for each item

</details>

<details>
<summary><b>🤖 Claude AI Skill</b></summary>

This tool includes a Claude AI skill that enables AI assistants to automatically use the Azure DevOps tool when users ask about work items, queries, or tasks.

**Installing the Skill:**

```bash
# Using skill-installer (if available)
tools skill-installer install azure-devops

# Or manually copy the skill file
cp skills/azure-devops.skill ~/.codex/skills/
```

**Skill Features:**
- Automatic tool invocation when users mention work items, queries, or Azure DevOps URLs
- Work item analysis with codebase exploration agents
- Automatic query handling and task organization

The skill triggers on phrases like "get workitem", "fetch task", "show query", "download tasks", "analyze workitem", "analyze task", or Azure DevOps URLs.

</details>

---

### 11. 🤖 Git Commit

> Generate AI-powered commit messages for your staged changes, with optional detailed descriptions and push functionality!

<details>
<summary><b>✨ Features</b></summary>

-   🤖 Generates 4 commit message suggestions using Google Gemini AI
-   📝 Interactive commit message selection
-   📃 Optional detailed commit messages with body text (`--detail`)
-   📦 Optional staging of all changes (`--stage`)
-   🚀 Optional automatic push after commit
-   🔍 Shows diff preview in verbose mode

</details>

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Generate commit for already staged changes
tools git-commit

# Stage all changes first, then commit
tools git-commit --stage

# Generate detailed commit messages with body text
tools git-commit --detail

# Stage changes and generate detailed commits
tools git-commit --stage --detail

# Verbose mode to see diff preview
tools git-commit --verbose
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option      | Alias | Description                                      |
| ----------- | ----- | ------------------------------------------------ |
| `--stage`   | `-s`  | Stage all changes before committing              |
| `--detail`  | `-d`  | Generate detailed commit messages with body text |
| `--verbose` | `-v`  | Enable verbose logging                           |
| `--help`    | `-h`  | Show help message                                |

</details>

<details>
<summary><b>⚙️ Configuration</b></summary>

**Required Environment Variable:**

```bash
export OPENROUTER_API_KEY=your_openrouter_api_key
```

The tool uses Google's Gemini 2.0 Flash Lite model via OpenRouter for fast, high-quality commit messages.

</details>

<details>
<summary><b>📋 Workflow</b></summary>

1. **Stage Changes (Optional)** → Runs `git add .` if `--stage` is used
2. **Analyze Diff** → Examines staged changes
3. **Generate Messages** → AI creates 4 contextual commit messages
    - With `--detail`: Each message includes a summary line and detailed body
    - Without `--detail`: Just concise summary lines
4. **Select Message** → Choose the best one interactively
5. **Commit** → Creates commit with chosen message
6. **Push (Optional)** → Asks if you want to push to remote

</details>

---

# Useful notes

<details>
<summary><b>🔌 MCP (Model Context Protocol)</b></summary>

### 🌐 Global MCP Server Installation

For system-wide access to MCP servers:

```bash
bun add --global \
  @modelcontextprotocol/inspector \
  @modelcontextprotocol/server-sequential-thinking \
  @modelcontextprotocol/server-filesystem \
  @modelcontextprotocol/server-github \
  @modelcontextprotocol/server-puppeteer \
  @modelcontextprotocol/server-brave-search \
  @executeautomation/playwright-mcp-server \
  @eslint/mcp \
  interactive-mcp
```

### 🔧 MCP Configuration Example for Claude Desktop

> 📌 **Important**: Claude Desktop seems to lose ability to find tools in the $PATH. For that reason, the "command" needs to have the FULL path to the tool (to find where it is, run `which tools` or `which mcp-server-github` for example)

Here's a complete MCP example configuration for Claude Desktop:

```json
{
    "mcpServers": {
        "github": {
            "command": "/Users/YourName/.bun/bin/mcp-server-github",
            "args": [],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_...."
            }
        },
        "ripgrep": {
            "command": "/Users/YourName/PathTo/GenesisTools/tools",
            "args": ["mcp-ripgrep"],
            "env": {
                "SHELL": "/bin/zsh"
            }
        },
        "sequential-thinking": {
            "command": "/opt/homebrew/bin/mcp-server-sequential-thinking",
            "args": [],
            "env": {}
        },
        "puppeteer": {
            "command": "/Users/YourName/.bun/bin/mcp-server-puppeteer",
            "args": [],
            "env": {}
        },
        "brave-search": {
            "command": "/Users/YourName/.bun/bin/mcp-server-brave-search",
            "env": {
                "BRAVE_API_KEY": "BSAIV......"
            }
        },
        "filesystem": {
            "command": "/Users/YourName/.bun/bin/mcp-server-filesystem",
            "args": ["/Users/YourName/PathTo/Projects/"]
        },
        "context": {
            "command": "context7-mcp"
        },
        "eslint-mcp": {
            "type": "stdio",
            "command": "/Users/Yourname/.bun/bin/bun",
            "args": ["x", "@eslint/mcp@latest"],
            "env": {}
        }
    },
    "globalShortcut": ""
}
```

### 🔧 MCP Configuration Example for Cursor

Here's a complete MCP configuration for Cursor:

```json
{
    "mcpServers": {
        "ripgrep": {
            "command": "tools mcp-ripgrep",
            "args": ["--root", "/Users/YourName/Projects/"],
            "env": {}
        },
        "github": {
            "command": "mcp-server-github",
            "args": [],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_..."
            }
        },
        "sequential-thinking": {
            "command": "mcp-server-sequential-thinking",
            "args": [],
            "env": {}
        },
        "puppeteer": {
            "command": "mcp-server-puppeteer",
            "args": [],
            "env": {}
        },
        "brave-search": {
            "command": "mcp-server-brave-search",
            "env": {
                "BRAVE_API_KEY": "..."
            }
        },
        "context": {
            "command": "context7-mcp"
        },
        "filesystem": {
            "command": "mcp-server-filesystem",
            "args": ["/Users/YourName/Allowed/Directory/"]
        }
    }
}
```

</details>

## 🐍 Python Package Management Tips

<details>
<summary><b>Install packages with isolated environments using pipx</b></summary>

```bash
# Install pipx
brew install python-argcomplete pipx && pipx ensurepath

# Optional: Enable global access
sudo pipx ensurepath --global

# For autocomplete
pipx completions
echo 'eval "$(register-python-argcomplete pipx)"' >> ~/.zshrc
source ~/.zshrc
```

</details>

<details>
<summary><b>Monitor Process Usage</b></summary>

```bash
# Install psrecord
pipx install 'psrecord[plot]'

# Record process usage
psrecord <pid> --interval 1 --duration 60 --plot usage.png
```

</details>

---

### 21. 🌳 Git Rebase Multiple

> Safe branch hierarchy rebasing with full rollback capability. Rebase a parent branch and automatically rebase all its child branches using correct fork points.

<details>
<summary><b>🎯 Quick Examples</b></summary>

```bash
# Interactive mode (recommended)
tools git-rebase-multiple

# Show current state and backups
tools git-rebase-multiple --status

# Preview plan without making changes
tools git-rebase-multiple --dry-run

# Abort and restore all branches
tools git-rebase-multiple --abort

# Continue after resolving conflicts
tools git-rebase-multiple --continue

# Cleanup backup refs when done
tools git-rebase-multiple --cleanup
```

</details>

<details>
<summary><b>⚙️ Options</b></summary>

| Option | Alias | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help message |
| `--abort` | `-a` | Abort and restore all branches |
| `--continue` | `-c` | Continue after resolving conflicts |
| `--status` | `-s` | Show current state and backups |
| `--cleanup` | | Remove all backup refs and fork tags |
| `--restore <branch>` | `-r` | Restore single branch from backup |
| `--dry-run` | | Show execution plan without running |

</details>

<details>
<summary><b>✨ Features</b></summary>

- **Backup Refs**: Creates `refs/backup/grm/<branch>` refs that survive git gc
- **Fork Point Tags**: Saves `fork/<child>` tags for accurate `--onto` rebasing
- **State Persistence**: Tracks progress in `.git/rebase-multiple-state.json`
- **Verbose Output**: Shows every git command being executed
- **Full Rollback**: Abort at any point and restore all branches to original state
- **Auto-Detection**: Automatically finds child branches of the parent being rebased

</details>

<details>
<summary><b>📖 Example Scenario</b></summary>

```
Before:
  main:     A---B---C---D
                 \
  feature:        E---F
                       \
  child-1:              G---H
                       \
  child-2:              I

After rebasing feature onto main (with children):
  main:     A---B---C---D
                         \
  feature:                E'--F'
                               \
  child-1:                      G'--H'
                               \
  child-2:                      I'
```

</details>

---

<a href="https://www.star-history.com/#genesiscz/GenesisTools&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date" />
 </picture>
</a>

---

<div align="center">
  
  ### 🌟 Built with ❤️ by developers, for developers
  
  <p>
    <a href="https://github.com/genesiscz/GenesisTools">⭐ Star this repo</a> •
    <a href="https://github.com/genesiscz/GenesisTools/issues">🐛 Report Bug</a> •
    <a href="https://github.com/genesiscz/GenesisTools/pulls">✨ Contribute</a>
  </p>
  
</div>

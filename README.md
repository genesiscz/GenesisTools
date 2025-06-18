# 🌟 GenesisTools

<div align="center">
  
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

- [🚀 Quick Start](#-quick-start)
- [🛠️ Available Tools](#️-available-tools)
  - [🔍 Git & Version Control](#-git--version-control)
  - [🤖 AI & Analysis](#-ai--analysis)
  - [📊 Monitoring & Watching](#-monitoring--watching)
  - [📦 Package Management](#-package-management)
- [💡 Tool Details](#-tool-details)

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

| Tool | Description |
|------|-------------|
| **[Git Commit](#11--git-commit)** | 🤖 AI-powered commit messages with auto-staging |
| **[Git Last Commits Diff](#1--git-last-commits-diff)** | 📝 View diffs between recent commits |
| **[GitHub Release Notes](#3--github-release-notes)** | 📋 Generate beautiful release notes |

### 🤖 AI & Analysis

| Tool | Description |
|------|-------------|
| **[Collect Files for AI](#2--collect-files-for-ai)** | 🤖 Aggregate project files for AI analysis |
| **[Files to Prompt](#8--files-to-prompt)** | 💬 Convert files to AI-friendly prompts |
| **[Hold-AI](#10--hold-ai-tool)** | ⏸️ Control AI responses via WebSocket |
| **[MCP Ripgrep](#9--mcp-ripgrep)** | ⚡ Lightning-fast code search server |
| **[MCP TS Introspect](#12--mcp-ts-introspect)** | 🔍 TypeScript export introspection tool & MCP server |
| **[TS AI Indexer](#13--ts-ai-indexer)** | 📊 Generate comprehensive TypeScript project indexes |

### 📊 Monitoring & Watching

| Tool | Description |
|------|-------------|
| **[Watchman](#5--watchman)** | 👁️ Monitor file changes with Facebook Watchman |
| **[Watch](#6--watch-formerly-watch-glob)** | 🔄 Real-time file monitoring with glob patterns |

### 📦 Package Management

| Tool | Description |
|------|-------------|
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

| Option | Description |
|--------|-------------|
| `<directory>` | 📁 Path to Git repository (required) |
| `--commits, -c` | 🔢 Number of recent commits to diff |
| `--output, -o` | 💾 Save diff to file |
| `--clipboard, -cl` | 📋 Copy diff to clipboard |
| `--help, -h` | ❓ Show help message |

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
- `--commits, -c NUM` - Files from last NUM commits
- `--staged, -s` - Only staged files
- `--unstaged, -u` - Only unstaged files  
- `--all, -a` - All uncommitted files (default)

**📁 Output Options**:
- `--target, -t DIR` - Custom output directory
- `--flat, -f` - Copy files without preserving directory structure

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

- 🎯 Watch files matching any glob pattern
- 📡 Real-time content updates
- 🆕 Auto-detect new files
- 🏠 Tilde expansion support (`~`)
- ⚡ Configurable polling intervals
- 📊 Directory & file summaries

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

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--seconds` | `-s` | Polling interval | `3` |
| `--verbose` | `-v` | Detailed logging | `false` |
| `--follow` | `-f` | Tail mode | `false` |
| `--lines` | `-n` | Lines to display | `50` |

</details>

---

### 7. 🎨 NPM Package Diff

> **🚀 Lightning-fast, beautiful diffs between NPM package versions**

A powerful command-line tool that creates temporary directories, installs package versions in parallel, watches for file changes during installation, and shows beautiful diffs with multiple output formats.

![Features](https://img.shields.io/badge/Features-12+-brightgreen?style=for-the-badge) ![Output Formats](https://img.shields.io/badge/Output_Formats-5-blue?style=for-the-badge) ![Performance](https://img.shields.io/badge/Performance-Parallel-orange?style=for-the-badge)

<details>
<summary><b>🌟 Key Features</b></summary>

**🎨 Visual Excellence**
- Beautiful colored terminal diffs with syntax highlighting
- Side-by-side and line-by-line comparisons
- Interactive HTML reports with toggle views
- Delta integration for GitHub-style diffs

**📊 Smart Analysis**
- File size comparisons and statistics
- Addition/deletion line counts
- Glob pattern filtering (include/exclude)
- Binary file detection and skipping

**⚡ Performance**
- Parallel package installation
- Efficient file watching during install
- Configurable timeouts
- Multi-package manager support (npm, yarn, pnpm, bun)

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

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--filter` | `-f` | Glob pattern to include files | `**/*.d.ts` |
| `--exclude` | `-e` | Glob pattern to exclude files | - |
| `--output` | `-o` | Output file path | console |
| `--format` | `-F` | Output format (terminal/unified/html/json/side-by-side) | `terminal` |
| `--patch` | `-p` | Generate patch file | - |
| `--verbose` | `-v` | Enable verbose logging | `false` |
| `--silent` | `-s` | Suppress output except errors | `false` |
| `--stats` | - | Show statistics summary | `false` |
| `--sizes` | - | Compare file sizes | `false` |
| `--line-numbers` | - | Show line numbers | `true` |
| `--word-diff` | - | Show word-level differences | `false` |
| `--side-by-side` | - | Side-by-side view | `false` |
| `--context` | - | Context lines in diff | `3` |
| `--use-delta` | - | Use delta for output | `false` |
| `--keep` | `-k` | Keep temporary directories | `false` |

</details>

<details>
<summary><b>📋 Output Formats (`--format`)</b></summary>

- **🖥️ terminal** - Colored diff with syntax highlighting (default)
- **📄 unified** - Standard patch format for git apply
- **🌐 html** - Interactive web page with toggle views
- **📊 json** - Structured data for programmatic use
- **↔️ side-by-side** - Split-screen terminal comparison

</details>

---

### 8. 💬 Files to Prompt

> Convert your codebase into AI-friendly prompts with intelligent formatting and filtering.

<details>
<summary><b>✨ Features</b></summary>

- 🎯 Multiple output formats (XML, Markdown, plain text)
- 📁 Recursive directory processing
- 🔍 Extension and pattern filtering
- 👻 Hidden file handling
- 📊 Line number support
- 🚫 Gitignore respect
- 📂 Flat folder structure copying with renamed files

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

- **search** - Basic pattern search with highlighting
- **advanced-search** - Extended options (word boundaries, symlinks, etc.)
- **count-matches** - Count occurrences efficiently
- **list-files** - List searchable files
- **list-file-types** - Show supported file types

</details>

<details>
<summary><b>⚙️ MCP Configuration</b></summary>

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "ripgrep": {
      "command": "tools mcp-ripgrep",
      "args": [
        "--root",
        "/Root/Path/For/Project/"
      ],
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

### 11. 🤖 Git Commit

> Generate AI-powered commit messages for your staged changes, with optional detailed descriptions and push functionality!

<details>
<summary><b>✨ Features</b></summary>

- 🤖 Generates 4 commit message suggestions using Google Gemini AI
- 📝 Interactive commit message selection
- 📃 Optional detailed commit messages with body text (`--detail`)
- 📦 Optional staging of all changes (`--stage`)
- 🚀 Optional automatic push after commit
- 🔍 Shows diff preview in verbose mode

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

| Option | Alias | Description |
|--------|-------|-------------|
| `--stage` | `-s` | Stage all changes before committing |
| `--detail` | `-d` | Generate detailed commit messages with body text |
| `--verbose` | `-v` | Enable verbose logging |
| `--help` | `-h` | Show help message |

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

### 12. 🔍 MCP TS Introspect

> Powerful TypeScript export introspection tool that analyzes packages, source code, or projects - works as both CLI and MCP server!

<details>
<summary><b>✨ Features</b></summary>

- 🔍 **Three Introspection Modes**:
  - **Package**: Analyze npm packages (supports npm, yarn, pnpm)
  - **Source**: Analyze TypeScript code snippets
  - **Project**: Analyze entire TypeScript projects
- 🚀 **Dual Operation Modes**:
  - CLI tool for command-line usage
  - MCP server for AI assistant integration
- 📊 **Smart Analysis**:
  - Extract function, class, type, and const exports
  - Full TypeScript type signatures
  - JSDoc comment extraction
  - Regex-based filtering
- ⚡ **Performance**:
  - File-based caching (7-day TTL)
  - Parallel processing
  - Result limiting

</details>

<details>
<summary><b>🎯 CLI Examples</b></summary>

```bash
# Interactive mode
tools mcp-ts-introspect

# Analyze a package
tools mcp-ts-introspect -m package -p typescript -t "^create" --limit 10

# Analyze source code
tools mcp-ts-introspect -m source -s "export function hello() { return 'world'; }"

# Analyze current project
tools mcp-ts-introspect -m project --search-term "Controller$" -o exports.json

# Copy results to clipboard
tools mcp-ts-introspect -m package -p @types/node -t "^read" -o clipboard
```

</details>

<details>
<summary><b>⚙️ CLI Options</b></summary>

| Option | Alias | Description |
|--------|-------|-------------|
| `--mode` | `-m` | Introspection mode: package, source, or project |
| `--package` | `-p` | Package name to introspect |
| `--source` | `-s` | TypeScript source code to analyze |
| `--project` | | Project path (defaults to current directory) |
| `--search-term` | `-t` | Regex pattern to filter exports |
| `--search-paths` | | Additional paths to search for packages |
| `--cache` | | Enable caching (default: true) |
| `--cache-dir` | | Cache directory (default: .ts-morph-cache) |
| `--limit` | | Maximum number of results |
| `--output` | `-o` | Output destination: stdout, clipboard, or file |
| `--verbose` | `-v` | Enable verbose logging |
| `--mcp` | | Run as MCP server |

</details>

<details>
<summary><b>🔧 MCP Server Mode</b></summary>

Run as an MCP server for AI assistants:

```bash
tools mcp-ts-introspect --mcp
```

**MCP Configuration for Claude Desktop:**

```json
{
  "mcpServers": {
    "ts-introspect": {
      "command": "/path/to/GenesisTools/tools",
      "args": ["mcp-ts-introspect", "--mcp"]
    }
  }
}
```

**Available MCP Tools:**

1. **introspect-package** - Analyze npm packages
   - `packageName` (required): Package to analyze
   - `searchPaths`, `searchTerm`, `cache`, `cacheDir`, `limit`

2. **introspect-source** - Analyze TypeScript code
   - `sourceCode` (required): Code to analyze
   - `searchTerm`, `limit`

3. **introspect-project** - Analyze TypeScript projects
   - `projectPath`: Project directory
   - `searchTerm`, `cache`, `cacheDir`, `limit`

</details>

---

### 13. 📊 TS AI Indexer

> Generate comprehensive, AI-friendly documentation from TypeScript codebases with detailed type information and relationships.

<details>
<summary><b>✨ Features</b></summary>

- 📊 **Complete Project Analysis**:
  - Classes with methods, properties, and inheritance
  - Interfaces with all members
  - Functions with full signatures
  - Types and type aliases
  - Enums and constants
  - Import/export relationships
- 📝 **Smart Documentation**:
  - JSDoc comment extraction
  - Type simplification for readability
  - Decorator information
  - Access modifiers (public/private/protected)
- 🎨 **Output Formats**:
  - **Compact**: Concise, AI-optimized format
  - **Detailed**: Full documentation with all details
- ⚡ **Performance**:
  - Fast TypeScript AST analysis
  - Configurable file exclusion
  - Memory-efficient processing

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
      "args": [
        "mcp-ripgrep"
      ],
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
      "args": [
        "/Users/YourName/PathTo/Projects/"
      ]
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

<div align="center">
  
  ### 🌟 Built with ❤️ by developers, for developers
  
  <p>
    <a href="https://github.com/genesiscz/GenesisTools">⭐ Star this repo</a> •
    <a href="https://github.com/genesiscz/GenesisTools/issues">🐛 Report Bug</a> •
    <a href="https://github.com/genesiscz/GenesisTools/pulls">✨ Contribute</a>
  </p>
  
</div>
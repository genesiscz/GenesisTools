# mcp-ripgrep

MCP (Model Context Protocol) server that wraps ripgrep for fast code search, designed for AI assistants.

## Features

- Fast pattern searching using ripgrep
- Relative path support from a configurable root directory
- Multiple search modes: basic, advanced, count, and file listing
- Rich options for filtering and formatting results

## Prerequisites

- [ripgrep](https://github.com/BurntSushi/ripgrep) must be installed and available in PATH

## CLI Options

| Option   | Description                              |
| -------- | ---------------------------------------- |
| `--root` | Set search root directory (default: cwd) |

## MCP Tools

### 1. `search`

Basic pattern search with common options.

**Parameters:**

| Parameter       | Type               | Required | Description                                        |
| --------------- | ------------------ | -------- | -------------------------------------------------- |
| `pattern`       | string             | Yes      | The search pattern (regex by default)              |
| `path`          | string             | Yes      | Path to search (relative to root)                  |
| `caseSensitive` | boolean            | No       | Use case sensitive search (default: auto)          |
| `filePattern`   | string \| string[] | No       | Glob pattern(s) to filter files (e.g., `*.js`)     |
| `maxResults`    | number             | No       | Limit the number of matching lines                 |
| `context`       | number             | No       | Show N lines before and after each match           |
| `useColors`     | boolean            | No       | Use colors in output (default: false)              |

### 2. `advanced-search`

Extended search with all ripgrep options.

**Parameters:**

All parameters from `search`, plus:

| Parameter           | Type    | Required | Description                                      |
| ------------------- | ------- | -------- | ------------------------------------------------ |
| `fixedStrings`      | boolean | No       | Treat pattern as literal string, not regex       |
| `fileType`          | string  | No       | Filter by file type (e.g., `js`, `py`)           |
| `invertMatch`       | boolean | No       | Show lines that don't match the pattern          |
| `wordMatch`         | boolean | No       | Only show matches surrounded by word boundaries  |
| `includeHidden`     | boolean | No       | Search in hidden files and directories           |
| `followSymlinks`    | boolean | No       | Follow symbolic links                            |
| `showFilenamesOnly` | boolean | No       | Only show filenames of matches, not content      |
| `showLineNumbers`   | boolean | No       | Show line numbers (default: true)                |

### 3. `count-matches`

Count pattern occurrences in files.

**Parameters:**

| Parameter       | Type               | Required | Description                                        |
| --------------- | ------------------ | -------- | -------------------------------------------------- |
| `pattern`       | string             | Yes      | The search pattern (regex by default)              |
| `path`          | string             | Yes      | Path to search (relative to root)                  |
| `caseSensitive` | boolean            | No       | Use case sensitive search (default: auto)          |
| `filePattern`   | string \| string[] | No       | Glob pattern(s) to filter files                    |
| `countLines`    | boolean            | No       | Count matching lines instead of total matches      |
| `useColors`     | boolean            | No       | Use colors in output (default: false)              |

### 4. `list-files`

List files that would be searched without actually searching.

**Parameters:**

| Parameter       | Type               | Required | Description                            |
| --------------- | ------------------ | -------- | -------------------------------------- |
| `path`          | string             | Yes      | Path to list (relative to root)        |
| `filePattern`   | string \| string[] | No       | Glob pattern(s) to filter files        |
| `fileType`      | string             | No       | Filter by file type (e.g., `js`, `py`) |
| `includeHidden` | boolean            | No       | Include hidden files and directories   |

### 5. `list-file-types`

List all supported file types in ripgrep.

**Parameters:** None

## MCP Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ripgrep": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/GenesisTools/src/mcp-ripgrep/index.ts",
        "--root",
        "/path/to/your/project"
      ]
    }
  }
}
```

### Claude Code (VS Code Extension)

Add to your `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "ripgrep": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/GenesisTools/src/mcp-ripgrep/index.ts",
        "--root",
        "${workspaceFolder}"
      ]
    }
  }
}
```

## Usage Examples

### Basic Search

Search for "TODO" comments in the src directory:

```json
{
  "tool": "search",
  "arguments": {
    "pattern": "TODO",
    "path": "src"
  }
}
```

### Search with File Filter

Search for imports in TypeScript files only:

```json
{
  "tool": "search",
  "arguments": {
    "pattern": "^import",
    "path": ".",
    "filePattern": "*.ts"
  }
}
```

### Advanced Search

Find all function definitions with word boundaries:

```json
{
  "tool": "advanced-search",
  "arguments": {
    "pattern": "function",
    "path": "src",
    "wordMatch": true,
    "fileType": "ts",
    "context": 2
  }
}
```

### Count Matches

Count occurrences of "console.log" in the codebase:

```json
{
  "tool": "count-matches",
  "arguments": {
    "pattern": "console\\.log",
    "path": "."
  }
}
```

### List Files

List all JavaScript and TypeScript files:

```json
{
  "tool": "list-files",
  "arguments": {
    "path": "src",
    "filePattern": ["*.js", "*.ts"]
  }
}
```

## Path Resolution

All paths are resolved relative to the configured `--root` directory. Use:

- `.` for the root directory
- `src` for the src subdirectory
- `src/components` for nested directories
- `filename.txt` for specific files

Output paths are displayed relative to the root for readability.

## Source

`src/mcp-ripgrep/index.ts`

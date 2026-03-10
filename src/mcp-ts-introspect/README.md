# TypeScript Introspect Tool

A command-line tool for introspecting TypeScript exports from packages, source code, or projects. Can also run as an MCP (Model Context Protocol) server.

Forked from https://github.com/t3ta/ts-introspect-mcp-server/tree/master/src

## Usage

```bash
tools mcp-ts-introspect [options]
```

## Modes

The tool supports three introspection modes:

### 1. Package Mode

Introspect TypeScript exports from npm packages:

```bash
tools mcp-ts-introspect -m package -p typescript -t "Type.*"
tools mcp-ts-introspect -m package -p @types/node --limit 20
```

### 2. Source Mode

Analyze TypeScript source code directly:

```bash
tools mcp-ts-introspect -m source -s "export function hello() { return 'world'; }"
```

### 3. Project Mode

Analyze an entire TypeScript project:

```bash
tools mcp-ts-introspect -m project --project ./my-project
tools mcp-ts-introspect -m project --search-term "^get" --limit 20
```

## Options

-   `-m, --mode MODE` - Introspection mode: package, source, or project
-   `-p, --package NAME` - Package name to introspect (for package mode)
-   `-s, --source CODE` - TypeScript source code to analyze (for source mode)
-   `--project PATH` - Project path to analyze (for project mode, defaults to current directory)
-   `--search-paths PATH` - Additional paths to search for packages (can use multiple times)
-   `-t, --search-term TERM` - Filter exports by search term (supports regex)
-   `--cache` - Enable caching (default: true)
-   `--cache-dir DIR` - Cache directory (default: .ts-morph-cache)
-   `--limit NUM` - Maximum number of results to return
-   `-o, --output DEST` - Output destination: file, clipboard, or stdout (default: stdout)
-   `-v, --verbose` - Enable verbose logging
-   `-h, --help` - Show help message
-   `--mcp` - Run as MCP server

## Examples

### Interactive Mode

Run without arguments for interactive prompts:

```bash
tools mcp-ts-introspect
```

### Find specific exports in a package

```bash
tools mcp-ts-introspect -m package -p typescript -t "^create" --limit 10
```

### Analyze source code and copy to clipboard

```bash
tools mcp-ts-introspect -m source -s "$(cat myfile.ts)" -o clipboard
```

### Analyze current project

```bash
tools mcp-ts-introspect -m project --search-term "Controller$" -o exports.json
```

## Features

-   **Package Resolution**: Supports npm, yarn, and pnpm package managers
-   **Caching**: Speeds up repeated lookups with file-based caching
-   **Filtering**: Use regex patterns to filter exports by name, type, or description
-   **Multiple Output Formats**: Output to stdout, clipboard, or file
-   **JSDoc Support**: Extracts descriptions from JSDoc comments
-   **TypeScript Support**: Full TypeScript type information extraction

## MCP Server Mode

Run the tool as an MCP server to integrate with AI assistants:

```bash
tools mcp-ts-introspect --mcp
```

### MCP Configuration

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
    "mcpServers": {
        "ts-introspect": {
            "command": "tools",
            "args": ["mcp-ts-introspect", "--mcp"]
        }
    }
}
```

### Available MCP Tools

When running as an MCP server, the following tools are available:

1. **introspect-package** - Introspect TypeScript exports from an npm package

    - `packageName` (required): The npm package name
    - `searchPaths`: Additional search paths
    - `searchTerm`: Regex filter pattern
    - `cache`: Enable caching (default: true)
    - `cacheDir`: Cache directory
    - `limit`: Maximum results

2. **introspect-source** - Analyze TypeScript source code

    - `sourceCode` (required): TypeScript source to analyze
    - `searchTerm`: Regex filter pattern
    - `limit`: Maximum results

3. **introspect-project** - Analyze a TypeScript project
    - `projectPath`: Path to project (defaults to current directory)
    - `searchTerm`: Regex filter pattern
    - `cache`: Enable caching (default: true)
    - `cacheDir`: Cache directory
    - `limit`: Maximum results

## Notes

-   The tool requires TypeScript declaration files (.d.ts) for package introspection
-   Caching is enabled by default and stores results for 7 days
-   Use verbose mode (-v) for debugging and additional logging
-   When running as MCP server, logs are written to the GenesisTools log directory

# tsc-single - TypeScript Diagnostics Tool

TypeScript diagnostics checker that can run as both a CLI tool and an MCP server. It supports checking individual files, directories, or glob patterns against your project's tsconfig.json.

## Features

- ✅ **CLI Mode**: Check TypeScript files from the command line
- ✅ **MCP Server Mode**: Run as a persistent MCP server for AI assistants
- ✅ **Dual Checking Methods**: Use TypeScript Compiler API or LSP
- ✅ **Glob Pattern Support**: Check multiple files using patterns
- ✅ **Persistent LSP**: In MCP mode, LSP stays running for faster checks
- ✅ **Clean Architecture**: Reusable `LspWorker` class for LSP management

## CLI Usage

### Basic Examples

```bash
# Check a single file
tools tsc-single src/app.ts

# Check all TypeScript files in a directory
tools tsc-single src

# Check files using glob patterns (use quotes!)
tools tsc-single 'src/**/*.ts'

# Check multiple paths
tools tsc-single src tests

# Mix files and patterns
tools tsc-single src/app.ts 'tests/**/*.test.ts'
```

### Options

```bash
--lsp        # Use typescript-language-server instead of compiler API
--warnings   # Show warnings in addition to errors
--mcp        # Run as MCP server (see MCP Mode below)
```

### Examples with Options

```bash
# Use LSP for checking (faster for incremental checks)
tools tsc-single --lsp src/app.ts

# Show warnings too
tools tsc-single --warnings src/app.ts

# Combine options
tools tsc-single --lsp --warnings 'src/**/*.ts'
```

## MCP Server Mode

Run tsc-single as a persistent MCP server that AI assistants can use to check TypeScript files.

### Starting the Server

```bash
# Run MCP server for current directory
tools tsc-single --mcp .

# Run MCP server for a specific project
tools tsc-single --mcp /path/to/project
```

### MCP Configuration

Add to your MCP settings (e.g., Claude Desktop config):

```json
{
  "mcpServers": {
    "typescript-diagnostics": {
      "command": "/path/to/GenesisTools/tools",
      "args": ["tsc-single", "--mcp", "/path/to/your/project"]
    }
  }
}
```

### Available MCP Tool

#### `GetTsDiagnostics`

Get TypeScript diagnostics for files matching the specified patterns.

**Parameters:**
- `files` (required): String or array of file paths/glob patterns
  - Examples: `"src/app.ts"`, `"src/**/*.ts"`, `["file1.ts", "file2.ts"]`
- `showWarnings` (optional): Include warnings in addition to errors (default: false)

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

**Response Format:**

```
Checked 5 file(s)
✓ No issues found
```

Or with errors:

```
Checked 3 file(s)
✗ Found 2 error(s)

src/app.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts:25:12 - error TS2339: Property 'foo' does not exist on type 'Bar'.
```

## Architecture

### LspWorker Class

The `LspWorker` class manages the TypeScript Language Server lifecycle:

```typescript
const worker = new LspWorker({ cwd: process.cwd(), debug: true });

// Start the LSP server
await worker.start();

// Get diagnostics for files
const result = await worker.getDiagnostics(files, { showWarnings: true });

// Format diagnostics for display
const formatted = worker.formatDiagnostics(result, showWarnings);

// Clean up
await worker.shutdown();
```

**Key Features:**
- Persistent LSP connection (reusable across multiple checks)
- Automatic diagnostic collection
- Configurable wait times
- Clean shutdown handling

### File Resolution

Both CLI and MCP modes use the same file resolution logic:

1. **Direct files**: Absolute or relative file paths
2. **Directories**: Recursively finds `**/*.{ts,tsx,js,jsx}`
3. **Glob patterns**: Standard glob matching (*, **, ?, [], {})
4. **Filtering**: Only includes files in tsconfig.json

### Checking Methods

**Compiler API** (default):
- Uses TypeScript's programmatic API
- Creates full program for proper type checking
- More accurate for complex projects

**LSP** (with `--lsp`):
- Uses typescript-language-server
- Faster for incremental checks
- Matches IDE behavior exactly

## Performance

### CLI Mode
- Compiler API: ~500ms-2s (depends on project size)
- LSP: ~200ms-1s (includes LSP startup)

### MCP Mode
- First check: ~200ms-1s (LSP already running)
- Subsequent checks: ~100-500ms (reuses LSP connection)

## Exit Codes

- `0`: Success (no errors)
- `1`: Usage error or no files found
- `2`: TypeScript errors found

## Environment Variables

- `DEBUG=1`: Enable verbose logging in CLI mode

## Troubleshooting

### "tsconfig.json not found"
Ensure you're running the command from within a TypeScript project with a valid tsconfig.json.

### "None of the matched files are included in tsconfig.json"
The files you specified aren't part of your TypeScript project. Check your tsconfig.json include/exclude patterns.

### LSP timeout
For very large projects, the LSP may timeout waiting for diagnostics. This is controlled by the `maxWaitMs` parameter (default: 30 seconds).

## Dependencies

- `typescript`: TypeScript compiler
- `ts-lsp-client`: LSP client library
- `@modelcontextprotocol/sdk`: MCP server SDK
- `glob`: File pattern matching

## Related Tools

- `mcp-ripgrep`: Similar MCP server architecture for code search
- Standard `tsc`: Full TypeScript compiler (checks entire project)

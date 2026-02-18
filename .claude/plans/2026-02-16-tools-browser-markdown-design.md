# Tools Browser & Markdown-CLI Enhancement — Design

**Date**: 2026-02-16
**Branch**: `feat/tools-index-markdown`
**Approach**: B — Modular `src/tools/` with shared utilities

## Problems to Solve

1. **`tools <partial>`** — treats partial input as literal script ID, fails with ugly multi-line error
2. **Error formatting** — 5+ `logger.error()` calls for a single "not found" error
3. **`tools` (no args)** — basic @inquirer search selector, no descriptions, just copies to clipboard
4. **`markdown-cli`** — thin wrapper, missing --watch, --width, --theme flags

## Design

### 1. Entry Point (`tools` file) — Routing & Fuzzy Match

**Current**: exact match only → error
**New**: exact match → run. No match → fuzzy search available tools → @clack selector (pre-filtered). No args → launch `src/tools/`.

Error formatting: single clean message with chalk, e.g.:
```
  Tool "cli-" not found. Did you mean?
    cli-markdown
```

### 2. Interactive Browser (`src/tools/index.ts`)

@clack/prompts-based interactive tool explorer:

1. ASCII logo + intro
2. Searchable tool list with descriptions
3. Select a tool → rendered README preview (via `renderMarkdownToCli`)
4. Drill into subcommands → Commander-extracted commands/options tree
5. Build command interactively → copies to clipboard or runs directly

**Description sources** (priority order):
1. Tool's `description` field from Commander `.description()` (extracted at runtime)
2. First meaningful line from tool's `README.md`
3. Fallback: tool name humanized

### 3. Tool Discovery (`src/tools/lib/discovery.ts`)

- Scan `src/` for tools (same logic as current `getAvailableTools`)
- Extract descriptions from multiple sources
- Cache results for session performance

### 4. Commander Introspection (`src/tools/lib/introspect.ts`)

- Run `bun run <tool> --help` and parse the structured output
- Extract: subcommands, options, descriptions, defaults
- Present as navigable tree in the browser

### 5. README Preview (`src/tools/lib/preview.ts`)

- Load tool's README.md
- Render via `renderMarkdownToCli()`
- Display in a scrollable/paged format

### 6. Markdown-CLI Enhancements (`src/markdown-cli/index.ts`)

New flags:
- `--watch` — re-render on file change (using fs.watch or chokidar)
- `--width <n>` — set output width (default: terminal width)
- `--theme <name>` — dark (default), light, minimal
- `--no-color` — strip ANSI codes

Engine changes in `src/utils/markdown/index.ts`:
- Accept options object: `{ width?, theme?, color? }`
- Theme affects chalk color choices for headings, links, code blocks

## File Structure

```
tools                              # Entry point: routing + fuzzy match + clean errors
src/tools/index.ts                 # Interactive browser (main)
src/tools/lib/discovery.ts         # Tool scanning + description extraction
src/tools/lib/introspect.ts        # Commander --help parsing
src/tools/lib/preview.ts           # README rendering + display
src/utils/markdown/index.ts        # Enhanced: width/theme/color options
src/markdown-cli/index.ts          # Enhanced: new CLI flags
```

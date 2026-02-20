# Debugging Master - Brainstorm Record

*Date: 2026-02-19*

## Problem

Debugging with LLM assistants is painful. The AI reads code statically, guesses at fixes, and has no access to runtime data. This leads to speculative fixes, wasted iterations, and frustrated developers.

## Inspiration

- **Cursor Debug Mode** ([blog post](https://cursor.com/blog/debug-mode)): Hypothesis-driven debugging with code instrumentation. Key insight: runtime data beats static analysis. Loop: Hypothesize -> Instrument -> Reproduce -> Analyze -> Fix -> Verify -> Clean up.
- **HAR Analyzer** (this repo): Token-efficient data viewing with 3-level output, reference system, `suggestCommand()`, session management.

## Research: Existing Tools

### Tier 1 (Most relevant)
- **`schickling/dilagent`** (102 stars): Parallel hypothesis testing in git worktrees, counter-experiment validation, structured experiment tracking
- **`jasonjmcghee/claude-debugs-for-you`** (486 stars): Real debugger (DAP) integration via MCP
- **`Syncause/debug-skill`** (9 stars): Mandatory evidence gathering before fixing, trace diffs, method snapshot inspection

### Tier 2 (Useful patterns)
- **`bunasQ/cursor-debug-mode`**: Cleanest NDJSON server implementation, `debugSnippet()` generator, `summarizeLogs()` grouping
- **`doraemonkeys/claude-code-debug-mode`**: `#region DEBUG` markers, hypothesis-tagged logs
- **`originalix/runtime-debugging`**: JSONL format with hypothesis IDs, environment-aware host detection

### Gaps in landscape (our differentiators)
1. No progressive detail levels (L1/L2/L3)
2. No reference system for large values
3. No JMESPath querying on captured data
4. No token budget awareness
5. No smart summarization with schema inference

## Decisions

### Transport
- **File-based** (JSONL to `~/.genesis-tools/debugging-master/sessions/<session>.jsonl`)
- **HTTP server mode** as alternative (`tools debugging-master start --serve`) for browser/zero-import use cases

### Instrumentation snippet
- **Copy-paste model**: `src/utils/debugging-master/llm-log.ts` is copied to target project
- Placement configured in `~/.genesis-tools/debugging-master/config.json` (global project map)
- `start` command: TTY -> Clack prompt with tree-based suggestions; non-TTY -> error with suggestCommand
- Two modes:
  - **File mode**: Import `llm-log.ts`, use `dbg.*` methods, writes via `appendFileSync`
  - **HTTP mode**: `start --serve` runs local server, LLM pastes inline `fetch()` calls in `// #region @dbg` blocks

### Auto-track cleanup
- `// @dbg` line markers for file mode
- `// #region @dbg` / `// #endregion @dbg` block markers for inline mode
- `cleanup` command scans project and removes tagged lines/blocks
- Manual LLM removal as fallback

### JSON query syntax
- **JMESPath** via `@jmespath-community/jmespath`
- Covers dot notation (`foo.bar.baz`), wildcards (`[*]`), projections (`{name: name, id: id}`), filtering (`[?status=='error']`)
- LLMs already know it from AWS CLI training data

### Log entry types (10)
dump, info, warn, error, timerStart, timerEnd, checkpoint, assert, snapshot, trace

### Additional features (from research)
- **Hypothesis tagging**: Optional `{h: 'H1'}` param on all methods, filterable
- **Log summary view**: Grouped overview before detail (5 dumps, 3 checkpoints, 1 timer pair avg 340ms)
- **Snippet generator**: `tools debugging-master snippet dump userData` outputs a ready-to-paste line
- **Server resilience**: Invalid JSON input saved as raw data in correct JSONL shape

### Interface
- CLI only (no MCP server)
- Skill teaches recommended workflows + freeform API usage

### Workflow model
- Hybrid: Cursor-style hypothesis loop as recommended example, freeform as alternative
- Not forced, just taught

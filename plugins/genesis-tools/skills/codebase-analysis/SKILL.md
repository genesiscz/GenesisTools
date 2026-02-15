---
name: genesis-tools:codebase-analysis
description: Deep codebase analysis without cluttering main session
context: fork
---

# Codebase Analysis

Perform deep codebase exploration and analysis in an isolated sub-agent context. Heavy Grep/Glob operations stay separate from your main work.

## Built-in Analysis Types

| Type | What it finds |
|------|---------------|
| `dependencies` | Import/require graph, circular dependencies, unused imports |
| `dead-code` | Exported but never-imported functions, unreachable code paths |
| `api-surface` | Public exports, REST endpoints, RPC methods |
| `type-safety` | `any` types, type assertions, missing return types |
| `error-handling` | Uncaught promises, empty catch blocks, missing error boundaries |
| `test-coverage` | Files without corresponding test files, untested exports |
| `security` | Hardcoded secrets, unsanitized inputs, eval usage |
| `patterns` | Custom pattern matching (permissions, money, DTOs, etc.) |

## Usage

```
/codebase-analysis --type=<type> [--output=summary|detailed]
```

Examples:
```bash
/codebase-analysis --type=type-safety          # Find all `any` types and unsafe casts
/codebase-analysis --type=dead-code            # Find unused exports
/codebase-analysis --type=error-handling       # Audit error handling patterns
/codebase-analysis --type=patterns             # Custom pattern (prompted interactively)
```

## Tools Available in Fork Context

| Tool | Purpose |
|------|---------|
| `tools mcp-tsc <file>` | TypeScript diagnostics per file via persistent LSP |
| `tools mcp-ripgrep` | Code search MCP server for structured queries |
| `tools collect-files-for-ai <dir> -c N` | Gather top N relevant files for analysis |
| `tools files-to-prompt <dir> --cxml` | Generate structured context XML |

## How It Works

1. **Launches isolated agent** -- intensive searching runs in parallel
2. **Performs extensive Grep/Glob** without blocking main session
3. **Analyzes patterns** and cross-references findings
4. **Returns structured report** to main session
5. **You continue working** while analysis runs

## Report Format

```markdown
## [Analysis Type] Report

**Scanned:** N files | **Findings:** N issues | **Severity:** High/Medium/Low

### Finding 1: [description]
- **File:** `src/utils/format.ts:L45`
- **Issue:** [what's wrong]
- **Suggestion:** [how to fix]

### Summary
| Severity | Count |
|----------|-------|
| High | N |
| Medium | N |
| Low | N |
```

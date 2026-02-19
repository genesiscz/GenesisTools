---
name: genesis-tools:claude-history
description: Search Claude Code conversation history. Use for finding past conversations by keywords, files modified, tools used, or time range. Triggers on "find conversation", "search history", "where did I", "where did you", "when did we discuss", "find where", "look up our conversation".
---

# Claude History Search

Search through Claude Code conversation history to find past interactions.

## Quick Reference

```bash
# Basic search
tools claude history "keyword"

# Search with filters
tools claude history "query" --tool Edit --since "7 days ago"

# Interactive mode
tools claude history -i
```

## Common Use Cases

### Find by Keywords
```bash
tools claude history "backup mcp-manager refactor"
tools claude history "authentication bug" --exact
```

### Find by File Modified
```bash
tools claude history --file "config/api.php"
tools claude history --file "*.tsx" --tool Edit
```

### Find by Tool Usage
```bash
tools claude history --tool Edit --since "7 days ago"
tools claude history --tool Task --limit 50
```

### Find by Project
```bash
tools claude history "timer" --project GenesisTools
tools claude history "migration" --all  # Search all projects
```

### Show Context
```bash
tools claude history "timer" --context 10  # 10 messages before/after
```

## CLI Options

| Option | Description |
|--------|-------------|
| `-i, --interactive` | Interactive mode with autocomplete |
| `-p, --project <name>` | Filter by project name |
| `--all` | Search all projects |
| `-f, --file <pattern>` | Filter by file path pattern |
| `-t, --tool <name>` | Filter by tool (Edit, Write, Bash, etc.) |
| `--since <date>` | Since date (e.g., "7 days ago", "yesterday") |
| `--until <date>` | Until date |
| `-l, --limit <n>` | Limit results (default: 20) |
| `-c, --context <n>` | Show N messages before/after match |
| `--exact` | Exact match instead of fuzzy |
| `--regex` | Use regex for query |
| `--agents-only` | Only search subagent conversations |
| `--exclude-agents` | Exclude subagent conversations |
| `--exclude-thinking` | Exclude thinking blocks |
| `--reindex` | Rebuild search index (use when index seems stale or after manual edits) |
| `--format <type>` | Output: ai (default), json |

## Output Formats

**Default (ai):** Perfect markdown with summaries and file paths
**With --context:** Shows surrounding messages in markdown
**JSON:** Raw JSON for programmatic use

## Summarize Sessions

Summarize Claude Code sessions using LLM-powered templates. Extracts key information and produces structured output in 7 modes.

### Quick Start

```bash
# Interactive mode — guided session & mode selection
tools claude history summarize -i

# Summarize a specific session
tools claude history summarize <session-id> --mode documentation

# Summarize current session (inside Claude Code)
tools claude history summarize --current --mode short-memory

# Output prompt only (no LLM call)
tools claude history summarize <session-id> --prompt-only --mode changelog
```

### Summarization Modes

| Mode | Description |
|------|-------------|
| `documentation` | Full technical doc: problem, changes, patterns, lessons |
| `memorization` | Comprehensive learnings organized by topic tags |
| `short-memory` | Concise MEMORY.md-ready bullets (500-2000 chars) |
| `changelog` | Added/Changed/Fixed/Removed with file paths |
| `debug-postmortem` | Symptoms, investigation, dead ends, root cause, fix |
| `onboarding` | "How this works" for new devs: architecture, key files |
| `custom` | Your own prompt with session content |

### Summarize Options

| Option | Description |
|--------|-------------|
| `-s, --session <id>` | Session ID (repeatable) |
| `--current` | Use current session from `$CLAUDE_CODE_SESSION_ID` |
| `--since <date>` | Sessions since date |
| `--until <date>` | Sessions until date |
| `-m, --mode <name>` | Template mode (default: documentation) |
| `--model <name>` | LLM model name |
| `--provider <name>` | LLM provider name |
| `--prompt-only` | Output the prepared prompt without calling LLM |
| `-o, --output <path>` | Write output to file |
| `--clipboard` | Copy output to clipboard |
| `--thorough` | Chunked summarization for large sessions |
| `--max-tokens <n>` | Token budget (default: 128000) |
| `--include-tool-results` | Include tool execution results |
| `--include-thinking` | Include thinking blocks |
| `--priority <type>` | Content priority: balanced, user-first, assistant-first |
| `-i, --interactive` | Interactive guided flow |
| `--custom-prompt <text>` | Custom prompt (for custom mode) |
| `--memory-dir <path>` | Output dir for memorization topic files |

### Examples

```bash
# Generate onboarding docs from a session
tools claude history summarize abc123 --mode onboarding -o docs/onboarding.md

# Extract debug learnings
tools claude history summarize abc123 --mode debug-postmortem --clipboard

# Memorization with topic files
tools claude history summarize abc123 --mode memorization --memory-dir ./memory/

# Large session with chunked processing
tools claude history summarize abc123 --mode documentation --thorough

# Custom analysis
tools claude history summarize abc123 --mode custom --custom-prompt "List all API endpoints discussed"

# Use specific model
tools claude history summarize abc123 --mode short-memory --provider anthropic --model claude-sonnet-4-5-20250929
```

## Dashboard

For visual exploration, `tools claude history-dashboard` launches a web-based React/Vite interface for browsing and analyzing conversation history.

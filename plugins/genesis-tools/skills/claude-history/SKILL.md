---
name: genesis-tools:claude-history
description: Search Claude Code conversation history. Use for finding past conversations by keywords, files modified, tools used, or time range. Triggers on "find conversation", "search history", "where did I", "where did you", "when did we discuss", "find where", "look up our conversation".
---

# Claude History Search

Search through Claude Code conversation history to find past interactions.

## Quick Reference

```bash
# Basic search
tools claude-history "keyword"

# Search with filters
tools claude-history "query" --tool Edit --since "7 days ago"

# Interactive mode
tools claude-history -i
```

## Common Use Cases

### Find by Keywords
```bash
tools claude-history "backup mcp-manager refactor"
tools claude-history "authentication bug" --exact
```

### Find by File Modified
```bash
tools claude-history --file "config/api.php"
tools claude-history --file "*.tsx" --tool Edit
```

### Find by Tool Usage
```bash
tools claude-history --tool Edit --since "7 days ago"
tools claude-history --tool Task --limit 50
```

### Find by Project
```bash
tools claude-history "timer" --project GenesisTools
tools claude-history "migration" --all  # Search all projects
```

### Show Context
```bash
tools claude-history "timer" --context 10  # 10 messages before/after
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

## Dashboard

For visual exploration, `tools claude-history-dashboard` launches a web-based React/Vite interface for browsing and analyzing conversation history.

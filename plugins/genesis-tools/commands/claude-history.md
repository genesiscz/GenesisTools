---
description: Search Claude Code conversation history. Use for finding past conversations by keywords, files modified, tools used, or time range. Triggers on "find conversation", "search history", "where did I", "where did you", "when did we discuss", "find where", "look up our conversation".
argument-hint: "[query] [--options]"
---

# Claude History Search

To exclude the current conversation, use `--exclude-session` with your session ID from the SessionStart message above (look for `$CLAUDE_CODE_SESSION_ID=<id>`):
```bash
tools claude-history $ARGUMENTS --exclude-session "<session-id>"
```

## Key Options

| Flag | Description |
|------|-------------|
| `--summary-only` | Search only titles/summaries (fastest for topic search) |
| `--exclude-session <id>` | Exclude a session ID (use $CLAUDE_CODE_SESSION_ID) |
| `--sort-relevance` | Sort by relevance score instead of date |
| `--commit <hash>` | Find conversation mentioning a git commit |
| `--commit-msg <text>` | Find conversation by commit message content |
| `--conv-date <date>` | Filter by conversation start date |
| `--list-summaries` | Quick list of conversation topics |
| `-c, --context <n>` | Show N messages around matches |
| `--since <date>` | Filter by date ("yesterday", "7 days ago") |
| `--file <path>` | Find conversations that modified a specific file |
| `--all` | Search all projects, not just current |

## Search Strategy

1. **By topic**: `--summary-only` (fastest)
2. **By content**: `--sort-relevance` (ranks results)
3. **By commit**: `--commit` or `--commit-msg`
4. **Always**: Add `--exclude-session <your-session-id>` to avoid self-matches

## Examples

```bash
# Find by topic (fast) - replace <session-id> with your actual session ID
tools claude-history "mcp-manager refactor" --summary-only --exclude-session "<session-id>"

# Find by commit hash
tools claude-history --commit "27a6fa9"

# Find by commit message
tools claude-history --commit-msg "safe config writing"

# Find recent work on a file
tools claude-history --file "backup.ts" --since "3 days ago" --exclude-session "<session-id>"

# List all conversation topics from last week
tools claude-history --list-summaries --since "7 days ago"

# Search with relevance ranking
tools claude-history "backup mechanism" --sort-relevance --exclude-session "<session-id>" -c 3
```

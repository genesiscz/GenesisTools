---
name: genesis-tools:github
description: |
  Efficiently interact with GitHub issues, PRs, and comments using the `tools github` CLI.
  Use when:
  - User provides a GitHub issue/PR URL and wants details or comments
  - User asks about recent activity on an issue
  - User wants to find issues/PRs matching criteria
  - User asks for comments starting from a specific point
  - User wants to filter comments by reactions, author, or date
---

# GitHub Tool Usage Guide

Search, fetch, and analyze GitHub issues, PRs, and comments with caching.

## Quick Reference

| Task | Command |
|------|---------|
| Get issue with comments | `tools github issue <url>` |
| Get last 5 comments | `tools github issue <url> --last 5` |
| Comments since specific one | `tools github comments <url>#issuecomment-123 --since 123` |
| High-reaction comments | `tools github issue <url> --min-reactions 10` |
| Exclude bots | `tools github issue <url> --no-bots` |
| Search issues | `tools github search "error" --repo owner/repo --state open` |
| Get PR with review comments | `tools github pr <url> --review-comments` |
| Check auth status | `tools github status` |

## URL Parsing

The tool automatically parses these URL formats:
- `https://github.com/owner/repo/issues/123`
- `https://github.com/owner/repo/pull/456`
- `https://github.com/owner/repo/issues/123#issuecomment-789`
- `owner/repo#123` (shorthand)
- `#123` or `123` (when in a git repo)

When user provides a URL with `#issuecomment-XXX`, use `--since XXX` to fetch from that point.

## Common Use Cases

### Get Issue/PR Details
```bash
# Fetch issue with first 30 comments
tools github issue https://github.com/anthropics/claude-code/issues/123

# Fetch PR with all comments
tools github pr https://github.com/owner/repo/pull/456 --all
```

### Filter Comments
```bash
# Last 10 comments only
tools github issue <url> --last 10

# Exclude bot comments
tools github issue <url> --no-bots

# Only high-value comments
tools github issue <url> --min-reactions 5

# Comments by specific author
tools github issue <url> --author username

# Comments after a date
tools github issue <url> --after 2025-01-15
```

### Get Updates Since Comment X
```bash
# When user shares URL with comment anchor
tools github comments "https://github.com/owner/repo/issues/123#issuecomment-789" --since 789

# Or just specify the ID
tools github issue <url> --since 789
```

### Search Issues/PRs
```bash
# Search open issues
tools github search "memory leak" --repo anthropics/claude-code --state open

# Search PRs only
tools github search "refactor" --type pr --repo owner/repo

# Sort by reactions
tools github search "bug" --sort reactions --limit 50
```

### Search Code (Files)
```bash
# Search for code containing text
tools github code "useState" --repo facebook/react

# Filter by path
tools github code "async function" --repo expo/expo --path "packages/**/*.ts"

# Filter by language
tools github code "interface Props" --repo vercel/next.js --language typescript
```

### Search Syntax Tips

**For Issues/PRs** (`tools github search`):
- Searches both issues and PRs by default
- Use `--type issue` or `--type pr` to filter
- Use `--repo owner/repo` to limit to a repository
- Use `--state open|closed` to filter by state
- Use `--sort reactions|comments|created|updated` to sort results

**For Code** (`tools github code`):
- **Recommended: specify `--repo`** for best results (API limitation)
- Use `--path "src/**/*.ts"` for path patterns
- Use `--language typescript` for language filtering
- Only searches default branch
- Files must be < 384 KB

**Query Examples:**
| Goal | Command |
|------|---------|
| Find open bugs in repo | `tools github search "bug" --repo owner/repo --type issue --state open` |
| Find PRs mentioning feature | `tools github search "dark mode" --repo owner/repo --type pr` |
| Find code using a function | `tools github code "useMemo" --repo facebook/react --language typescript` |
| Find config files | `tools github code "version" --repo owner/repo --path "*.json"` |

### PR-Specific Features
```bash
# Include code review comments
tools github pr <url> --review-comments

# Include diff
tools github pr <url> --diff

# Include commits
tools github pr <url> --commits

# Include CI check status
tools github pr <url> --checks
```

## Caching Behavior

- **Default storage:** `~/.genesis-tools/github/cache.db`
- **With `--save-locally`:** `<cwd>/.claude/github/`
- SQLite cache enables fast subsequent queries
- Incremental fetching saves API calls
- `--refresh` updates cache with new data
- `--full` forces complete refetch

### Refresh Patterns
```bash
# Auto-incremental (uses cache, fetches only new)
tools github issue <url>

# Force update cache
tools github issue <url> --refresh

# Complete refetch
tools github issue <url> --full
```

## Output Formats

| Format | Flag | Best For |
|--------|------|----------|
| AI/Markdown | `--format ai` | Reading, sharing with AI |
| JSON | `--format json` | Programmatic use |

### AI/Markdown Output Includes:
- Issue metadata (state, labels, assignees)
- Description with line numbers
- Timeline events (when using `--include-events`)
- Comments with reactions and reply indicators
- Statistics (when using `--stats`)
- Index section with line ranges

## CLI Options

### Issue Command
```
tools github issue <input> [options]

Options:
  -r, --repo <owner/repo>   Repository (auto-detected)
  -c, --comments            Include comments (default: true)
  -L, --limit <n>           Limit comments (default: 30)
  --all                     Fetch all comments
  --last <n>                Last N comments only
  --since <id|url>          Comments after this ID/URL
  --after <date>            Comments after date
  --before <date>           Comments before date
  --min-reactions <n>       Min reaction count
  --author <user>           Filter by author
  --no-bots                 Exclude bots
  --include-events          Include timeline events
  --resolve-refs            Fetch linked issues
  --full                    Force full refetch
  --refresh                 Update cache
  --save-locally            Save to .claude/github/
  -f, --format <format>     Output: ai|md|json
  -o, --output <file>       Custom output path
  --stats                   Show comment statistics
```

### PR Command
Same as issue, plus:
```
  --review-comments         Include review thread comments
  --diff                    Include PR diff
  --commits                 Include commit list
  --checks                  Include CI check status
```

### Search Command
```
tools github search <query> [options]

Options:
  --type <type>             Filter: issue|pr|all
  -r, --repo <owner/repo>   Limit to repository
  --state <state>           Filter: open|closed|all
  --sort <field>            Sort: created|updated|comments|reactions
  -L, --limit <n>           Max results (default: 30)
  -f, --format <format>     Output format
```

## Interactive Mode

Run `tools github` without arguments for interactive mode:
1. Select action: Issue / PR / Comments / Search
2. Enter URL or search query
3. Configure filters interactively
4. Choose output format
5. Continue with another query or exit

## Authentication

Uses GitHub token from (in priority order):
1. `GITHUB_TOKEN` environment variable
2. `GH_TOKEN` environment variable
3. `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable
4. `gh auth token` command (modern gh CLI)
5. `gh` CLI config file (legacy)

Check status with: `tools github status`

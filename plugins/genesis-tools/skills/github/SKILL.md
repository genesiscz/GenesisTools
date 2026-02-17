---
name: genesis-tools:github
description: |
  Efficiently interact with GitHub issues, PRs, comments, and code using the `tools github` CLI.
  Use when:
  - User provides a GitHub issue/PR URL and wants details or comments
  - User asks about recent activity on an issue
  - User wants to find issues/PRs matching criteria
  - User asks for comments starting from a specific point
  - User wants to filter comments by reactions, author, or date
  - User wants to search code in a repository (e.g. "find how X is implemented")
  - User wants to find issues or discussions about a library or framework
  - User asks "how does library X handle Y" or "are there issues about Z"
  - User asks to fix/address/review PR review comments → invoke the `genesis-tools:github-pr` skill instead
  - User provides multiple PR URLs to analyze → invoke the `genesis-tools:github-pr` skill instead
---

# GitHub Tool Usage Guide

Search, fetch, and analyze GitHub issues, PRs, and comments with caching.

## Quick Reference

| Task | Command |
|------|---------|
| Get issue with comments | `tools github issue <url>` |
| Get last 5 comments | `tools github issue <url> --last 5` |
| Comments since specific one | `tools github comments <url>#issuecomment-123 --since 123` |
| Filter issue by body reactions | `tools github issue <url> --min-reactions 10` |
| Filter comments by reactions | `tools github issue <url> --min-comment-reactions 5` |
| Filter by positive reactions | `tools github issue <url> --min-reactions-positive 3` |
| Exclude bots | `tools github issue <url> --no-bots` |
| Search with min reactions | `tools github search "bug" --repo owner/repo --min-reactions 10` |
| Search issues | `tools github search "error" --repo owner/repo --state open` |
| Get PR with review comments | `tools github pr <url> --review-comments` |
| Check auth status | `tools github status` |
| Get file content | `tools github get <file-url>` |
| Get specific lines | `tools github get <file-url> --lines 10-50` |
| Get file to clipboard | `tools github get <file-url> -c` |

## URL Parsing

The tool automatically parses these URL formats:
- `https://github.com/owner/repo/issues/123`
- `https://github.com/owner/repo/pull/456`
- `https://github.com/owner/repo/issues/123#issuecomment-789`
- `owner/repo#123` (shorthand)
- `#123` or `123` (when in a git repo)

When user provides a URL with `#issuecomment-XXX`, use `--since XXX` to fetch from that point.

## Get File Content

Fetch raw file content from any GitHub file URL.

### Supported URL Formats
- `https://github.com/owner/repo/blob/branch/path/to/file`
- `https://github.com/owner/repo/blob/tag/path/to/file`
- `https://github.com/owner/repo/blob/commit/path/to/file`
- `https://github.com/owner/repo/blame/ref/path/to/file`
- `https://raw.githubusercontent.com/owner/repo/ref/path/to/file`
- `https://raw.githubusercontent.com/owner/repo/refs/heads/branch/path`
- `https://raw.githubusercontent.com/owner/repo/refs/tags/tag/path`
- All above with `#L10` or `#L10-L20` line references

### Examples
```bash
# Get file from blob URL
tools github get https://github.com/facebook/react/blob/main/package.json

# Get specific lines from a file
tools github get https://github.com/owner/repo/blob/main/src/index.ts --lines 10-50

# Get file from blame URL
tools github get https://github.com/owner/repo/blame/v1.0.0/README.md

# Get file from raw URL
tools github get https://raw.githubusercontent.com/owner/repo/main/data.json

# Override the ref to get a different version
tools github get https://github.com/owner/repo/blob/main/file.ts --ref v2.0.0

# Copy to clipboard instead of stdout
tools github get https://github.com/owner/repo/blob/main/file.ts -c

# URL with line references (quotes needed for shell)
tools github get "https://github.com/owner/repo/blob/main/file.ts#L10-L20"

# Faster fetch via raw URL (skips API, less metadata)
tools github get https://github.com/owner/repo/blob/main/file.ts --raw
```

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

# Only comments with 5+ total reactions
tools github issue <url> --min-comment-reactions 5

# Only comments with positive reactions
tools github issue <url> --min-comment-reactions-positive 3

# Issue must have 10+ body reactions (skips if below threshold)
tools github issue <url> --min-reactions 10

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

# Search with minimum reaction count on issue/PR
tools github search "feature request" --repo owner/repo --min-reactions 5

# Search with minimum comment reactions (uses GraphQL, slower)
tools github search "bug" --repo owner/repo --min-comment-reactions 3

# Use only advanced or legacy search backend
tools github search "error" --repo owner/repo --advanced
tools github search "error" --repo owner/repo --legacy
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
# Include review threads (GraphQL, threaded with severity/suggestions)
tools github pr <url> --reviews

# Include review comments (REST, flat list — legacy, prefer --reviews)
tools github pr <url> --review-comments

# Include diff
tools github pr <url> --diff

# Include commits
tools github pr <url> --commits

# Include CI check status
tools github pr <url> --checks
```

### Review Threads (Code Review Workflow)

Fetch, reply to, and resolve PR review threads with severity detection and suggestions.

```bash
# View all review threads
tools github review 137

# Only unresolved threads
tools github review 137 -u

# Save as markdown to .claude/github/reviews/
tools github review 137 --md -g

# Reply to a thread
tools github review 137 --respond "Fixed in latest commit" -t <thread-id>

# Resolve a thread
tools github review 137 --resolve-thread -t <thread-id>

# Reply AND resolve
tools github review 137 --respond "Done" --resolve-thread -t <thread-id>

# Batch: resolve multiple threads (comma-separated IDs)
tools github review 137 --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3

# Batch: reply to multiple threads with same message
tools github review 137 --respond "Fixed in abc1234" -t PRRT_id1,PRRT_id2

# Batch: reply + resolve multiple threads
tools github review 137 --respond "Fixed" --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
```

> **PR review fix workflow:** If the user asks to fix, address, or analyze PR review comments — or provides multiple PR URLs — invoke the `genesis-tools:github-pr` skill. It handles the full end-to-end flow: fetch threads, critically evaluate each comment (pushing back on false positives), implement fixes, commit, reply to reviewers, and for multiple PRs: spawn parallel agents and produce a consolidated report.

### Resolving Review Threads

After fixing review comments, reply to and resolve threads:

```bash
# Reply to a thread
tools github review 137 --respond "Fixed in commit abc1234" -t <thread-id>

# Reply AND resolve in one command
tools github review 137 --respond "Fixed" --resolve-thread -t <thread-id>

# Resolve without replying
tools github review 137 --resolve-thread -t <thread-id>
```

**Permission note:** The `--resolve-thread` mutation requires a GitHub PAT with `pull_requests:write` scope. If it fails with "Resource not accessible by personal access token", the `--respond` reply will still succeed — you just can't auto-resolve. In that case, reply with status and let the user resolve manually on GitHub.

**After fixing PR comments, always:**
1. Reply to each addressed thread with: what was fixed, how it was fixed, and a **clickable link** to the commit using markdown: `[short-sha](https://github.com/owner/repo/commit/full-sha)` (e.g. "Fixed in [abc1234](https://github.com/owner/repo/commit/abc1234def5678) — scoped stale cleanup to current project directory.")
2. Reply "Won't fix" to deliberately skipped threads with a detailed explanation of why the change isn't warranted (technical reasoning, not just a dismissal)
3. Do NOT resolve threads automatically — only resolve when the user explicitly asks to resolve them

### Review Fix Workflow (End-to-End)

When fixing PR review comments:

1. **Fetch unresolved threads:** `tools github review <pr> -u`
2. **Read each file** mentioned in the threads
3. **Implement fixes** for each review comment
4. **Commit** with PR reference in message
5. **Reply to threads:** `tools github review <pr> --respond "Fixed in [sha](url)" -t <thread-ids>`
6. **Resolve threads** (only when user explicitly approves): `tools github review <pr> --resolve-thread -t <thread-ids>`

> For the full automated flow (fetch, triage, fix, commit, reply), invoke the `genesis-tools:github-pr` skill instead.

## Caching Behavior

- **Default storage:** `~/.genesis-tools/github/cache.db`
- **With `--save-locally`:** `<cwd>/.claude/github/`
- SQLite cache enables fast subsequent queries
- Auto-incremental: refreshes comments if cache > 5 min old
- `--refresh` forces incremental update regardless of age
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
  -r, --repo <owner/repo>                Repository (auto-detected)
  -c, --comments                         Include comments (default: true)
  -L, --limit <n>                        Limit comments (default: 30)
  --all                                  Fetch all comments
  --first <n>                            First N comments only
  --last <n>                             Last N comments only
  --since <id|url>                       Comments after this ID/URL
  --after <date>                         Comments after date
  --before <date>                        Comments before date
  --min-reactions <n>                    Min total reactions on issue/PR body
  --min-reactions-positive <n>           Min positive reactions on issue/PR body
  --min-reactions-negative <n>           Min negative reactions on issue/PR body
  --min-comment-reactions <n>            Min total reactions on comments
  --min-comment-reactions-positive <n>   Min positive reactions on comments
  --min-comment-reactions-negative <n>   Min negative reactions on comments
  --author <user>                        Filter by author
  --no-bots                              Exclude bots
  --include-events                       Include timeline events
  --no-resolve-refs                      Skip resolving linked issues (auto by default)
  --full                                 Force full refetch
  --refresh                              Update cache
  --save-locally                         Save to .claude/github/
  -f, --format <format>                  Output: ai|md|json
  -o, --output <file>                    Custom output path
  --stats                                Show comment statistics
  -v, --verbose                          Enable verbose logging
```

### PR Command
Same as issue (including all reaction filters), plus:
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
  --type <type>                Filter: issue|pr|all
  -r, --repo <owner/repo>     Limit to repository
  --state <state>              Filter: open|closed|all
  --sort <field>               Sort: created|updated|comments|reactions
  -L, --limit <n>              Max results (default: 30)
  --min-reactions <n>          Min reaction count on issue/PR
  --min-comment-reactions <n>  Min reactions on any comment (GraphQL, slower)
  --advanced                   Use only advanced search backend
  --legacy                     Use only legacy search backend
  -f, --format <format>        Output format
  -o, --output <file>          Output path
  -v, --verbose                Enable verbose logging
```

### Get Command
```
tools github get <url> [options]

Options:
  -r, --ref <ref>         Override branch/tag/commit ref
  -l, --lines <range>     Line range (e.g., 10 or 10-20)
  -o, --output <file>     Write to file
  -c, --clipboard         Copy to clipboard
  --raw                   Fetch via raw.githubusercontent.com (faster)
  -v, --verbose           Enable verbose logging
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

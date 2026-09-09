---
name: gt:claude-history
description: Find native Claude Code, Codex, or Grok conversations by topic, file, date, or session ID. Explain automatic indexing and provider-scoped resume. Not for codebase/git/Slack history.
---

# Native Conversation History

Use the matching `tools claude history`, `tools codex history`, or `tools grok history` command. The existing skill identifier remains for compatibility. Searches/listings build the index on first use and synchronize changed sources automatically; no manual indexing step is required.

## 🛑 Do NOT pipe to `head` / `tail`

`tools claude history` already bounds its own output. Piping it through `head -40` / `tail -20`:

- truncates the result set mid-record, so a match that WAS found looks absent;
- masks the real exit code (the pipeline reports `head`'s);
- can SIGPIPE the indexer mid-scan on `--all` runs.

Use the CLI's own bounds instead:

```bash
tools claude history "query" --all --limit 10             # fewer results
tools claude history "query" --all --limit 5 --context 0  # no surrounding messages
tools claude history "query" --all > /tmp/hist.md         # big result set → file, then Read it
```

Rules of thumb:

- Cap with `--limit`, never with `head`. Default is 20; drop to `5`-`10` for a scoped question.
- Normal queries search the synchronized native index, including assistant replies and supported tool results. Warm searches reuse unchanged transcripts; metadata and parser-version changes are detected automatically.
- `--summary-only` searches titles, summaries and the first real user prompt, not assistant replies or tool output. Use a normal query or `--file` for those.
- Need only a machine answer? `--format json | tools json` is fine — that is a converter, not a truncator.
- Redirecting to a file with `>` and then `Read`ing costs less than a re-run after a bad truncation. There is no `-o` flag on this command.

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
tools claude history --files ".vitrinka/" --all
```

`--file` / `--files` are repeatable aliases. They match tool-call `file_path` / `path` **and** other tool inputs (Bash `command`, Write `content`, …).

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
| `-f, --file <pattern>` | Match tool-call paths and tool inputs (repeatable) |
| `--files <pattern>` | Same as `--file` |
| `-t, --tool <name>` | Filter by tool (Edit, Write, Bash, etc.) |
| `--since <date>` | Since date (e.g., "7 days ago", "yesterday") |
| `--until <date>` | Until date |
| `-l, --limit <n>` | Limit results (default: 20) |
| `-c, --context <n>` | Show N original records before/after a match, preserving metadata/progress records too |
| `--exact` | Exact match instead of fuzzy |
| `--regex` | Use regex for query |
| `--agents-only` | Only search subagent conversations |
| `--exclude-agents` | Exclude subagent conversations |
| `--exclude-thinking` | Exclude thinking blocks |
| `history index status` | Read-only status; does not create an index |
| `history index sync` | Optional explicit sync; normal searches do this automatically |
| `history index rebuild` | Optional forced reparse; native sources remain unchanged |
| `--format <type>` | Output: ai (default), json |

## Output Formats

**Default (ai):** Markdown in a pipe, or a table in an interactive terminal
**With --context:** Shows surrounding messages in markdown
**JSON:** Raw JSON for programmatic use

## Automatic indexing and provider scope

Claude, Codex and Grok share `~/.genesis-tools/claude-history/index.db`, extending the existing Claude database. Normal search/list refreshes bounded metadata automatically; full text and original-record context are read from native sources. No login, manual sync or source migration is a prerequisite. Status stays read-only; explicit sync/rebuild are optional metadata maintenance.

The database also holds historical `usage_snapshots` and `spend_snapshots`. Never delete it as a cache reset or recreate those observation tables during history maintenance. Statistics refresh is separate from metadata refresh; an unavailable message/token count is unknown, not zero. Do not recreate the discarded `native-history` message mirrors or full-text store.

`--all` expands project scope within the selected provider, never across providers. Identity includes native ID and canonical source home. Historical account ownership stays unknown unless the source proves it.

```bash
tools codex history "invoice parser" --all --sort-relevance
tools grok history "rounding" --file '*.ts' --context 2
tools codex run work --model astra --resume "invoice parser"
tools claude run work --resume "invoice parser"
tools grok run --resume "invoice parser"
```

Bare `--resume` follows the native CLI: Claude/Codex picker, Grok most recent. A query uses indexed search; non-interactive ambiguity is an error. Claude keeps source homes distinct and refuses a foreign home with an explicit `CLAUDE_CONFIG_DIR` command. Codex copy prompts are separate from indexing. Never infer permission to migrate sources or import credentials from a history request.

## Summarize Sessions

Summarize Claude Code sessions using LLM-powered templates. Extracts key information and produces structured output in 7 modes.

### Quick Start

```bash
# Interactive mode — guided session & mode selection
tools claude summarize -i

# Summarize a specific session
tools claude summarize <session-id> --mode documentation

# Summarize current session (inside Claude Code)
tools claude summarize --current --mode short-memory

# Output prompt only (no LLM call)
tools claude summarize <session-id> --prompt-only --mode changelog
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
| `--current` | The active Claude Code session. Claude Code only: under grok or Codex it refuses, naming the host it detected, because the id is looked up in `~/.claude/projects` |
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
tools claude summarize abc123 --mode onboarding -o docs/onboarding.md

# Extract debug learnings
tools claude summarize abc123 --mode debug-postmortem --clipboard

# Memorization with topic files
tools claude summarize abc123 --mode memorization --memory-dir ./memory/

# Large session with chunked processing
tools claude summarize abc123 --mode documentation --thorough

# Custom analysis
tools claude summarize abc123 --mode custom --custom-prompt "List all API endpoints discussed"

# Use specific model
tools claude summarize abc123 --mode short-memory --provider anthropic --model claude-sonnet-4-5-20250929
```

## Extract shell quirks (zsh/bash NOMATCH)

Mine Claude session JSONLs for Bash tool calls that tripped on zsh 5.9 expansion quirks (`no matches found`, unquoted `?` in URLs, bare `===` equals-expansion, `*(N)` / nobareglobqual, for-loop aborts). Each finding includes the command, result excerpt, and **exact jsonl path + line** so another agent can jump straight there.

```bash
# Full report → file (notes-vault path example)
tools claude history extract-shell-quirks --all \
  -o ~/notes/claude/bugs/ZshBugs.extracted.md

# Machine JSON
tools claude history extract-shell-quirks --all --json --max 50

# One project only
tools claude history extract-shell-quirks -p GenesisTools -o /tmp/zsh.md
```

| Flag | Meaning |
|------|---------|
| `--all` | Scan every project under `~/.claude/projects` |
| `-p / --project` | Restrict to one project |
| `--max <n>` | Cap findings (do not use `-l`; parent `history` owns that) |
| `--exclude-agents` | Skip subagent transcripts |
| `--no-rule-codification` | Skip pure CLAUDE.md discussion hits |
| `--no-dedupe` | Keep repeated identical command+error occurrences as separate findings (default collapses to one with `×N`) |
| `-o / --output` | Write markdown report |
| `--json` | Findings JSON on stdout |

## Dashboard

For visual exploration, `tools claude history dashboard` launches a web-based React/Vite interface for browsing and analyzing conversation history.

For Codex and Grok's shared query selector, a full native UUID is an exact lookup across projects, never a fallback search for text mentioning the ID. Ordinary text queries remain scoped. Codex prefers an existing target-home copy when old homes retain the same ID and natively unarchives a canonical archived thread before resuming; an alternate-home migration still needs its own authorization.

---
name: gt:todo
description: |
  Manage project-scoped todos with rich context capture. Use when the user wants to track tasks, create reminders, link work items to PRs/issues, or manage work across sessions. Triggers on "add todo", "create task", "remind me to", "track this", "todo list", "what's on my plate", "mark done", "complete task", "what should I work on". Also use proactively when the user mentions wanting to remember something for later or needing to follow up.
---

# Todo Management Tool

Create, track, and manage project-scoped todos with auto-captured git context, session tracking, and Apple Calendar/Reminders sync.

Every todo is a **context capsule** — it captures the full git state (branch, commit, staged/unstaged changes), environment info, and session ID at creation time so any future session can pick up the work with zero context loss.

## CLI Reference

```bash
# Create
tools todo add "Fix the auth bug" \
  --priority high \
  --tag auth,backend \
  --reminder "24h" --reminder "3d" \
  --link pr:142 --link ado:78901 \
  --session-id $CLAUDE_CODE_SESSION_ID \
  --attach ./screenshot.png \
  --md ./notes.md \
  --description "The OAuth flow breaks when..."

# List
tools todo list                              # current project, active todos
tools todo list --all                        # all projects
tools todo list --status done                # filter by status
tools todo list --priority critical,high     # filter by priority
tools todo list --tag auth                   # filter by tag
tools todo list --session $CLAUDE_CODE_SESSION_ID
tools todo list --format ai|json|md|table

# Show detail
tools todo show <id>
tools todo show <id> --format ai

# Status transitions
tools todo start <id>
tools todo block <id>
tools todo complete <id> --note "Fixed in commit abc123"
tools todo reopen <id>

# Edit
tools todo edit <id> --priority critical
tools todo edit <id> --add-tag urgent
tools todo edit <id> --add-reminder "1h"
tools todo edit <id> --add-link pr:99

# Search
tools todo search "auth bug"
tools todo search "OAuth" --all

# Remove
tools todo remove <id>

# Apple sync
tools todo sync <id> --to calendar
tools todo sync <id> --to reminders
tools todo sync --all --to reminders

# Import/Export
tools todo export --format json > todos.json
tools todo import todos.json
```

## LLM Usage Guidelines

### Always Do

1. **Pass session ID** on every `add` command:
   ```bash
   tools todo add "..." --session-id $CLAUDE_CODE_SESSION_ID
   ```

2. **Use `--format ai`** when reading todos back for context:
   ```bash
   tools todo list --format ai
   tools todo show <id> --format ai
   ```

3. **Link external resources** when working on PRs, issues, or ADO work items:
   ```bash
   --link pr:142           # GitHub PR
   --link issue:456        # GitHub issue
   --link ado:78901        # Azure DevOps work item
   --link https://...      # any URL
   ```

4. **Embed context** with `--md` for complex todos:
   ```bash
   --md ./spec.md          # inline the file content into the todo
   ```

5. **Set priority** based on conversation urgency:
   - User says "urgent", "ASAP", "critical" → `--priority critical`
   - User says "important", "soon" → `--priority high`
   - Default → `--priority medium`
   - User says "whenever", "low priority", "nice to have" → `--priority low`

6. **Track status** as you work:
   ```bash
   tools todo start <id>                          # when beginning work
   tools todo complete <id> --note "summary"      # when finishing
   tools todo block <id>                          # when stuck
   ```

### Checking Session Todos

At the start of a session, check for existing todos:
```bash
tools todo list --session $CLAUDE_CODE_SESSION_ID --format ai
```

Or check all active todos for the project:
```bash
tools todo list --format ai
```

### Creating From Conversation

When the user says something like "remind me to..." or "I need to...", create a todo:
```bash
tools todo add "What the user wants to track" \
  --priority <infer from context> \
  --tag <relevant tags from the discussion> \
  --session-id $CLAUDE_CODE_SESSION_ID \
  --link <any relevant PR/issue> \
  --description "Additional context from the conversation"
```

### Reminders

Reminders support relative and absolute times:
```bash
--reminder "30m"                    # 30 minutes from now
--reminder "24h"                    # 24 hours
--reminder "3d"                     # 3 days
--reminder "1w"                     # 1 week
--reminder "2026-04-02 10:00"       # absolute datetime
```

Multiple reminders can be specified:
```bash
--reminder "24h" --reminder "3d"    # remind at 24h and again at 3d
```

## Output Formats

| Format | Best For | Default When |
|--------|----------|-------------|
| `ai` | LLM consumption, compact | Non-TTY (piped) |
| `table` | Human scanning of lists | TTY list |
| `md` | Detailed single-todo view | TTY show |
| `json` | Machine processing, export | Explicit only |

## Storage

Todos are stored per-project at `~/.genesis-tools/todo/projects/<hash>/todos.json`. Each todo captures the full git state at creation time. Use `--all` to query across all projects.

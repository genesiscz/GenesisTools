---
name: genesis-tools:azure-devops
description: Interact with Azure DevOps work items, queries, dashboards, and time logging. Use when user asks to get/fetch/show work items, queries, tasks, bugs from Azure DevOps. Also handles analyzing work items and time logging. Triggers on phrases like "get workitem", "fetch task", "show query", "download tasks", "analyze workitem", "analyze task", "log time", "timelog", "time entry", or Azure DevOps URLs.
---

# Azure DevOps Work Item Tool

Fetch, manage, and analyze Azure DevOps work items using `tools azure-devops`.

## CLI Reference

```bash
tools azure-devops workitem <id|ids>             # Fetch work item(s)
tools azure-devops query <id|url|name>           # Fetch query results (supports name matching)
tools azure-devops query <id> --download-workitems  # Download all to files
tools azure-devops dashboard <id|url>            # Get dashboard queries
tools azure-devops list                          # List cached items
tools azure-devops workitem-create               # Create work item
tools azure-devops timelog configure             # Interactive: setup API key, user, allowed types
tools azure-devops timelog types                 # List available time types
tools azure-devops timelog list -w <id>          # List time logs for work item
tools azure-devops timelog add -w <id> -h <hrs>  # Log time entry (with precheck)
tools azure-devops timelog prepare-import add    # Stage entries for review before import
tools azure-devops timelog prepare-import list   # Review staged entries
tools azure-devops timelog prepare-import remove # Remove staged entry
tools azure-devops timelog prepare-import clear  # Clear all staged entries
tools azure-devops timelog import <file>         # Bulk import time logs (with precheck)
```

### Options

| Option | Description |
|--------|-------------|
| `--format ai\|md\|json` | Output format (default: ai) |
| `--force`, `--refresh` | Bypass cache |
| `--state <states>` | Filter by state (comma-separated) |
| `--severity <sev>` | Filter by severity (comma-separated) |
| `--download-workitems` | Download all items from query |
| `--category <name>` | Save to tasks/<category>/ |
| `--task-folders` | Save in tasks/<id>/ subfolder |
| `--attachments-from <datetime>` | Download attachments created after this date |
| `--attachments-to <datetime>` | Download attachments created before this date (default: now) |
| `--attachments-prefix <prefix>` | Only attachments starting with this name |
| `--attachments-suffix <suffix>` | Only attachments ending with this (e.g. .har) |
| `--output-dir <path>` | Custom directory for downloaded attachments |

### Output Paths

- **Tasks**: `.claude/azure/tasks/` → `<id>-<Slug-Title>.md`
- With `--category react19`: `.claude/azure/tasks/react19/<id>-<Slug>.md`
- With `--task-folders`: `.claude/azure/tasks/<id>/<id>-<Slug>.md`

### Attachment Output Paths

Attachments are downloaded when any `--attachments-*` filter flag is provided. Without filters, attachments are listed in output with a suggested download command.

- **Default**: Same folder as task file: `.claude/azure/tasks/<taskid>-<attachment-name>`
- With `--task-folders`: `.claude/azure/tasks/<id>/<taskid>-<attachment-name>`
- With `--output-dir /custom/path`: `/custom/path/<taskid>-<attachment-name>`

## Operations

### Fetch Work Items

```bash
tools azure-devops workitem 261575
tools azure-devops workitem 261575,261576,261577
tools azure-devops workitem 261575 --category react19
tools azure-devops workitem 261575 --force
```

### Fetch Query

The `--query` option supports three input formats:

1. **Query ID (GUID)**: `d6e14134-9d22-4cbb-b897-b1514f888667`
2. **Full URL**: `https://dev.azure.com/org/project/_queries/query/abc123`
3. **Query Name**: `"Otevřené bugy"` (fuzzy matching supported)

```bash
# By ID
tools azure-devops query d6e14134-9d22-4cbb-b897-b1514f888667

# By name (uses fuzzy matching to find the query)
tools azure-devops query "Open Bugs"
tools azure-devops query "Otevřené bugy"

# With filters
tools azure-devops query <id> --state Active,Development
tools azure-devops query "Active Tasks" --download-workitems --category react19
```

**Query Name Matching:**
- Exact matches are used immediately
- Fuzzy matching finds the closest query name if no exact match
- Shows alternatives if multiple similar queries exist
- Query list is cached for 1 day for fast lookups

### Analyze Work Items

When user says "analyze workitem/task X" or "analyze tasks from query Y":

1. Fetch work item(s):
   ```bash
   tools azure-devops workitem <ids> --category <cat> --task-folders
   ```

2. Read the generated `.md` file for each work item

3. Spawn **Explore agent** (Task tool with `subagent_type: "Explore"`) for each:

   ```
   Analyze codebase for Azure DevOps work item:

   **#{id}: {title}**
   State: {state} | Severity: {severity}

   **Description:** {description}
   **Comments:** {comments}

   Find:
   1. Relevant code files/components for this issue
   2. Current implementation and data flow
   3. Required changes
   4. Dependencies and related systems
   5. Complexity assessment

   Return: files found, current implementation, recommended approach, considerations, complexity (Low/Medium/High)
   ```

4. Write `.analysis.md` next to the work item file:
   - Work item: `.claude/azure/tasks/261575-Title.md`
   - Analysis: `.claude/azure/tasks/261575-Title.analysis.md`

### Analysis Document Format

```markdown
# Analysis: #{id} - {title}

**Analyzed**: {timestamp}
**Work Item**: {path to .md file}

## Summary
{1-2 sentence findings summary}

## Relevant Code
- `path/file.ts` - {purpose}

## Current Implementation
{How current code works}

## Recommended Approach
{Step-by-step plan}

## Considerations
- {Risks/considerations}

## Complexity: {Low|Medium|High}
{Reasoning}
```

## Examples

| User Request | Action |
|--------------|--------|
| "Get workitem 261575" | `tools azure-devops workitem 261575` |
| "Show query results for X" | `tools azure-devops query X` |
| "Show Open Bugs query" | `tools azure-devops query "Open Bugs"` |
| "Fetch Otevřené bugy" | `tools azure-devops query "Otevřené bugy"` |
| "Download React19 bugs" | `tools azure-devops query "React19 Bugs" --download-workitems --category react19` |
| "Analyze task 261575" | Fetch → Explore agent → Write .analysis.md |
| "Analyze all active bugs" | Fetch query with --download-workitems → Parallel Explore agents → Write .analysis.md files |
| "Download .har files from task 12345" | `tools azure-devops workitem 12345 --attachments-suffix .har` |
| "Get attachments from last hour for 12345" | Compute datetime 1h ago, then `tools azure-devops workitem 12345 --attachments-from "2026-02-12T10:00:00"` |
| "Download all attachments for task 12345" | `tools azure-devops workitem 12345 --attachments-from 2000-01-01` |

## Creating Work Items

The `--create` command supports multiple modes for creating new work items.

### CLI Reference

```bash
tools azure-devops workitem-create -i                     # Interactive mode
tools azure-devops workitem-create --from-file <path>     # From template file
tools azure-devops workitem-create <query-url> --type Bug # Generate template from query
tools azure-devops workitem-create <workitem-url>         # Generate template from work item
tools azure-devops workitem-create --type Task --title X  # Quick creation
```

### Create Options

| Option | Description |
|--------|-------------|
| `-i, --interactive` | Interactive mode with step-by-step prompts |
| `--from-file <path>` | Create from template JSON file |
| `--type <type>` | Work item type (Bug, Task, User Story, etc.) |
| `--title <text>` | Work item title (required for quick mode) |
| `--severity <sev>` | Severity level |
| `--tags <tags>` | Tags (comma-separated) |
| `--assignee <email>` | Assignee email |

### Creation Modes

#### 1. Interactive Mode (`-i`)

Best for: Manual creation with full control over all fields.

```bash
tools azure-devops workitem-create -i
```

Prompts for: type, title, description (via editor), severity, state, tags, assignee, parent link.

#### 2. Template from Query

Best for: Creating work items that match patterns from existing items.

```bash
tools azure-devops workitem-create "https://dev.azure.com/.../_queries/query/abc" --type Bug
```

This:
1. Analyzes work items from the query
2. Extracts common patterns (area paths, tags, severities used)
3. Generates a template with hints from analyzed items
4. Saves to `.claude/azure/tasks/created/template-<timestamp>.json`

#### 3. Template from Work Item

Best for: Cloning or creating similar work items.

```bash
tools azure-devops workitem-create "https://dev.azure.com/.../_workitems/edit/12345"
```

This:
1. Fetches the source work item
2. Generates a template pre-filled with matching values
3. Keeps parent reference if source had one
4. Saves to `.claude/azure/tasks/created/template-<timestamp>.json`

#### 4. From Template File

Best for: LLM workflows where templates are prepared programmatically.

```bash
tools azure-devops workitem-create --from-file ".claude/azure/tasks/created/template.json"
```

Template format:
```json
{
  "$schema": "azure-devops-workitem-v1",
  "type": "Bug",
  "fields": {
    "title": "Error in checkout flow",
    "description": "<p>Description here</p>",
    "severity": "A - critical",
    "tags": ["frontend", "checkout"],
    "assignedTo": "user@example.com",
    "areaPath": "Project\\Area",
    "iterationPath": "Project\\Sprint1"
  },
  "relations": {
    "parent": 12345
  }
}
```

#### 5. Quick Non-Interactive

Best for: Simple work items created from command line.

```bash
tools azure-devops workitem-create --type Task --title "Fix login bug"
tools azure-devops workitem-create --type Bug --title "Error" --severity "A - critical" --tags "frontend,urgent"
```

### LLM Workflow

When user asks to "create a work item" or "file a bug":

1. **Gather information** - Ask for: type, title, description, severity (if bug)

2. **Choose mode based on context**:
   - Have a template file? Use `--from-file`
   - Want to match existing patterns? Generate template from query first
   - Simple request? Use quick mode `--type X --title "Y"`
   - Complex with many fields? Use interactive mode

3. **Create the work item**:
   ```bash
   # Quick creation
   tools azure-devops workitem-create --type Bug --title "Error in checkout" --severity "B - high"

   # Or from template
   tools azure-devops workitem-create --from-file template.json
   ```

4. **Report the result** - Include the work item ID and URL in your response.

### Examples

| User Request | Action |
|--------------|--------|
| "Create a bug for the login issue" | `--create --type Bug --title "Login issue" --severity "B - high"` |
| "File a task to update docs" | `--create --type Task --title "Update documentation"` |
| "Create a bug like #12345" | `--create <workitem-url>` then `--from-file template.json` |
| "Help me create a detailed work item" | `--create -i` (interactive) |

## History Commands

Track work item history: who changed what, when, and how long items spent in each state.

### CLI Reference

```bash
tools azure-devops history show <id>                    # Summary view (assignment/state periods, time-in-state)
tools azure-devops history show <id> -f timeline        # Chronological events
tools azure-devops history show <id> -f json            # JSON output
tools azure-devops history show <id> --force            # Force refresh from API
tools azure-devops history show <id> --assigned-to "X"  # Filter by assignee
tools azure-devops history show <id> --state Active     # Filter by state

tools azure-devops history search --assigned-to-me --wiql          # Currently assigned to me (WIQL @Me)
tools azure-devops history search --assigned-to "Martin" --wiql    # Ever assigned to user (server-side)
tools azure-devops history search --assigned-to "Martin" --wiql --current  # Currently assigned
tools azure-devops history search --assigned-to "Martin"           # Local cached history search
tools azure-devops history search --assigned-to "Martin" --min-time 2h     # Min time filter
tools azure-devops history search --state Active --since 2024-12-01 --wiql # State + date range (--since/--until aliases for --from/--to)

tools azure-devops history sync                   # Bulk sync history for cached work items (per-item mode)
tools azure-devops history sync --force           # Force re-sync all
tools azure-devops history sync --dry-run         # Show what would be synced
tools azure-devops history sync --batch           # Use batch reporting API instead
```

### NL Query Translation

| User says | Command |
|-----------|---------|
| "tasks assigned to me" | `history search --assigned-to-me --wiql` |
| "tasks ever assigned to Martin" | `history search --assigned-to "Martin" --wiql` |
| "how long was #123 in Active" | `history show 123 --state Active` |
| "time Martin spent on #456" | `history show 456 --assigned-to Martin` |
| "all work in last 2 months" | `history search --assigned-to "Martin" --from 2024-12-01 --wiql` |

### Features

- **@me support**: `--assigned-to @me` or `--assigned-to-me` uses WIQL `@Me` macro (auto-enables WIQL)
- **--current flag**: Uses `=` instead of `EVER` for current assignment
- **Fuzzy user matching**: "Martin" matches "Martin Novak (QK)", diacritics normalized
- **Cache stats**: Local search shows data date range and last sync time
- **Per-item sync** (default): Targeted API calls per work item, faster for <200 items
- **Batch sync** (`--batch`): Uses reporting API, better for 500+ items

## TimeLog Operations

Time logging for Azure DevOps work items using the third-party TimeLog extension.

### Setup

```bash
# Interactive configuration (recommended)
tools azure-devops timelog configure
```

This launches an interactive prompt (using clack) that configures:
- `functionsKey`: TimeLog API key (auto-fetched from Azure DevOps)
- `defaultUser`: Your user email/name for time logging
- `allowedWorkItemTypes`: Work item types that can be logged to (e.g., "Bug,Task")
- `allowedStatesPerType`: Required states per type (e.g., "Task:In Progress")

The configuration is saved to `.claude/azure/config.json`.

**Note for LLM agents**: Since `configure` uses interactive clack prompts, you cannot drive it directly. Use `AskUserQuestion` to suggest the user run it themselves, or use non-interactive flags:

```bash
# Non-interactive mode (for scripting)
tools azure-devops timelog configure --allowed-work-item-types "Bug,Task" --allowed-states-for-type "Task:In Progress"
```

### List Time Types

```bash
tools azure-devops timelog types              # AI-friendly list
tools azure-devops timelog types --format json  # JSON output
```

### List Time Logs

```bash
tools azure-devops timelog list -w <workItemId>
tools azure-devops timelog list -w 268935 --format md
tools azure-devops timelog list --from 2026-02-01 --to 2026-02-08 --format json
tools azure-devops timelog list --from 2026-02-01 --to 2026-02-08 --user @me --format json
```

The `--user @me` resolves to the configured default username. Use `--from`/`--to` for date ranges (`--since`/`--upto` also accepted as aliases).

### Add Time Log Entry

```bash
# Quick mode (all options on CLI)
tools azure-devops timelog add -w <id> -h <hours> -t <type>
tools azure-devops timelog add -w 268935 -h 2 -t "Development"
tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"

# Interactive mode
tools azure-devops timelog add -i
tools azure-devops timelog add -w 268935 -i
```

Before creating the entry, the command runs a workitem type precheck (see Workitem Type Validation below).

### Prepare Entries for Import (Recommended for Batch Operations)

The `prepare-import` workflow allows you to stage, review, and validate entries before committing them to Azure DevOps.

```bash
# Stage entries for review
tools azure-devops timelog prepare-import add --from 2026-02-01 --to 2026-02-08 --entry '{
  "workItemId": 268935,
  "date": "2026-02-04",
  "hours": 2,
  "timeType": "Development",
  "comment": "Implemented feature X"
}'

# Add another entry (same date range)
tools azure-devops timelog prepare-import add --from 2026-02-01 --to 2026-02-08 --entry '{
  "workItemId": 262042,
  "date": "2026-02-04",
  "hours": 0.5,
  "timeType": "Ceremonie",
  "comment": "Daily standup"
}'

# Review all staged entries
tools azure-devops timelog prepare-import list --name 2026-02-01.2026-02-08 --format table

# Remove a specific entry if needed
tools azure-devops timelog prepare-import remove --name 2026-02-01.2026-02-08 --id <uuid>

# Clear all entries for this date range
tools azure-devops timelog prepare-import clear --name 2026-02-01.2026-02-08
```

The name is auto-generated from `--from` and `--to` as `<from>.<to>` (e.g., `2026-02-01.2026-02-08`). Each entry is validated with Zod schema and runs workitem type precheck before being added.

### Import Time Logs

```bash
# Import from prepare-import staging file
tools azure-devops timelog import .genesis-tools/azure-devops/cache/prepare-import/2026-02-01.2026-02-08.json

# Or import from custom JSON file
tools azure-devops timelog import entries.json

# Dry run to validate without creating entries
tools azure-devops timelog import entries.json --dry-run
```

The import command runs workitem type precheck for each entry before creating it. After import, the command shows a precheck summary with counts of passed/redirected/failed entries. The cache is automatically evicted after successful imports.

### Workitem Type Validation

Before creating time log entries, the tool validates that the workitem type is configured as allowed in `allowedWorkItemTypes`. This precheck behavior helps prevent errors:

**Automatic Redirect for User Stories:**
- If a workitem is a User Story (not typically allowed for time logging), the tool looks for child Tasks/Bugs
- Exactly 1 child of allowed type: Auto-redirect with warning
- 0 children of allowed type: Error
- Multiple children: Error with list for user to choose from

**Configuration:**
- Run `tools azure-devops timelog configure` to set `allowedWorkItemTypes`
- Common configuration: `"Bug,Task"` (excludes User Stories, Features, etc.)
- Can also configure `allowedStatesPerType` for additional validation

**Where Precheck Applies:**
- `timelog add` - Before creating single entry
- `timelog import` - Before importing each entry
- `prepare-import add` - When staging entry for review

### TimeLog Examples

| User Request | Action |
|--------------|--------|
| "Log 2 hours on task 268935" | `tools azure-devops timelog add -w 268935 -h 2 -t "Development"` |
| "What time types are available?" | `tools azure-devops timelog types` |
| "Show time logged on 268935" | `tools azure-devops timelog list -w 268935` |
| "Help me log time" | `tools azure-devops timelog add -i` |
| "Stage entries for review" | `tools azure-devops timelog prepare-import add --from ... --to ... --entry '{...}'` |
| "Review staged entries" | `tools azure-devops timelog prepare-import list --name 2026-02-01.2026-02-08` |
| "Import time entries from file" | `tools azure-devops timelog import entries.json` |
| "Import with validation only" | `tools azure-devops timelog import entries.json --dry-run` |

### Natural Language Time Logging

When user asks to log time in natural language, parse their request and construct the CLI command:

**1. Parse Duration Formats:**
- "1 hour", "1h", "1hr" → `-h 1`
- "30 minutes", "30min", "30m" → `-h 0 -m 30`
- "1.5 hours", "1h30m", "90 minutes" → `-h 1 -m 30`
- "2 hours 15 minutes" → `-h 2 -m 15`

**2. Extract Work Item IDs:**
- From explicit mention: "on task 268935", "workitem #268935", "WI 268935"
- From git branch: `feature/268935-fix-login` → work item 268935
- From recent commits: `feat(#268935): fix login bug` → work item 268935

To extract from git context:
```bash
# Get current branch
git branch --show-current

# Get recent commit messages (look for #NNNNNN patterns)
git log --oneline -5
```

**3. Infer Time Type from Context:**

| Context Clues | Time Type |
|---------------|-----------|
| "reviewing PR", "code review", "review" | Code Review |
| "implementing", "coding", "development", "fixing" | Development |
| "testing", "writing tests", "QA" | Test |
| "documentation", "docs", "readme" | Dokumentace |
| "meeting", "standup", "planning", "retro" | Ceremonie |
| "analysis", "analyzing", "design" | IT Analýza |
| "configuring", "setup", "deployment" | Konfigurace |

Default to "Development" if no context clues.

**4. Use Git Commit Messages as Notes:**

When user says "use commit message" or doesn't provide a note:
```bash
# Get last commit message
git log -1 --pretty=%B
```

Use the commit subject line as the time log comment.

### Natural Language Examples

| User Request | Parsed Command |
|--------------|----------------|
| "log 1h on 268935 for Development" | `timelog add -w 268935 -h 1 -t "Development"` |
| "spent 30min reviewing PR on task 789" | `timelog add -w 789 -h 0 -m 30 -t "Code Review"` |
| "log 2 hours, use last commit message" | Get work item from branch/commit, use commit msg as comment |
| "log my work on the current task" | Extract ID from branch, infer type from commits |
| "log 1.5h implementing the fix" | `timelog add -w <from-branch> -h 1 -m 30 -t "Development"` |

### Workflow: Log Time from Git Context

When user says "log time for my work" without explicit details:

1. **Get work item ID**:
   ```bash
   git branch --show-current  # e.g., feature/268935-fix-login
   ```
   Extract number: 268935

2. **Get commit messages for note**:
   ```bash
   git log -1 --pretty=%B
   ```

3. **Infer time type** from commit message keywords

4. **Ask user for duration** if not specified (use AskUserQuestion)

5. **Execute**:
   ```bash
   tools azure-devops timelog add -w 268935 -h <hours> -t "<inferred-type>" -c "<commit-message>"
   ```

## Integration with `tools git`

For gathering commit data to correlate with time entries, use the `tools git commits` command:

```bash
# Get commits for a date range with automatic workitem ID extraction
tools git commits --from 2026-02-01 --to 2026-02-08 --format json 2>/dev/null | tools json
```

This command:
- Extracts workitem IDs from commit messages and branch names via configured patterns
- Returns commit metadata (hash, message, author, date)
- Includes stats (files changed, insertions, deletions)
- Filters by configured authors (see `tools git configure authors`)

The extracted workitem IDs can be used to match commits to Azure DevOps work items for time logging purposes.

## HAR File Analysis from Work Items

When user explicitly asks to download and analyze HAR attachments from a work item:
```bash
# 1. Download HAR attachment
tools azure-devops workitem <id> --attachments-suffix .har --output-dir /tmp/har

# 2. Load and analyze with har-analyzer
tools har-analyzer load /tmp/har/<taskid>-capture.har
```

Do NOT download or analyze HAR files automatically -- only when the user requests it.

## Documentation Resources

For deeper API research beyond this skill:
- **Local docs**: `src/azure-devops/docs/` contains 14 reference files (work items, iterations, PRs, REST API, WIQL syntax, timelog history)
- **Context7**: Use library ID `/websites/learn_microsoft_en-us_rest_api_azure_devops` for detailed REST API specs
- **CLAUDE.md**: Contains context7 library IDs and batch endpoint quick reference

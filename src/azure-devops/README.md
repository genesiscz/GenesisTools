# azure-devops - Azure DevOps Work Item Tool

CLI tool for fetching, tracking, and managing Azure DevOps work items, queries, and dashboards with intelligent caching and change detection.

## Features

-   ✅ **Work Item Management**: Fetch individual work items with full details, comments, and relations
-   ✅ **Query Support**: Run Azure DevOps queries with change detection between runs
-   ✅ **Dashboard Integration**: Extract queries from dashboards automatically
-   ✅ **Smart Caching**: 5-minute cache for work items, 180-day cache for queries (with change detection)
-   ✅ **Change Detection**: Automatically detects new items and updates (state, assignee, severity, title changes)
-   ✅ **Task File Generation**: Saves work items as JSON and Markdown files for easy reference
-   ✅ **Category Organization**: Organize work items into categories (remembered per item)
-   ✅ **Task Folders**: Optional folder structure for better organization
-   ✅ **Batch Operations**: Fetch multiple work items or download all items from a query
-   ✅ **Filtering**: Filter queries by state and severity
-   ✅ **Multiple Output Formats**: AI-optimized, Markdown, or JSON output

## CLI Usage

### Basic Examples

```bash
# Configure for your project (first-time setup)
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"

# Fetch a work item
tools azure-devops --workitem 12345

# Fetch multiple work items
tools azure-devops --workitem 12345,12346,12347

# Fetch a query with change detection
tools azure-devops --query d6e14134-9d22-4cbb-b897-b1514f888667

# Filter query results by state
tools azure-devops --query <id> --state Active,Development

# Filter by severity
tools azure-devops --query <id> --severity A,B

# Download all work items from a query
tools azure-devops --query <id> --download-workitems

# Organize into categories
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes

# Use task folders (each task in its own subfolder)
tools azure-devops --workitem 12345 --task-folders

# Get dashboard queries
tools azure-devops --dashboard <url|id>

# List all cached work items
tools azure-devops --list

# Force refresh (bypass cache)
tools azure-devops --workitem 12345 --force

# Filter changes by date range
tools azure-devops --query <id> --changes-from 2026-01-24
tools azure-devops --query <id> --changes-from 2026-01-20 --changes-to 2026-01-25

# Create work items (interactive mode)
tools azure-devops --create -i

# Create from template file
tools azure-devops --create --from-file template.json

# Generate template from query (analyzes patterns)
tools azure-devops --create "https://dev.azure.com/.../query/abc" --type Bug

# Generate template from existing work item
tools azure-devops --create "https://dev.azure.com/.../_workitems/edit/12345"

# Quick non-interactive creation
tools azure-devops --create --type Task --title "Fix login bug"
tools azure-devops --create --type Bug --title "Error in checkout" --severity "A - critical"
```

### Commands

| Command        | Description                                    |
| -------------- | ---------------------------------------------- |
| `--configure`  | Configure Azure DevOps connection for project  |
| `--query`      | Fetch query results with change detection      |
| `--workitem`   | Fetch work item(s) with full details           |
| `--dashboard`  | Extract queries from a dashboard               |
| `--list`       | List all cached work items                     |
| `--create`     | Create new work items (interactive or from template) |

### Options

| Option                        | Description                                           | Default |
| ----------------------------- | ----------------------------------------------------- | ------- |
| `--format <ai\|md\|json>`     | Output format                                         | `ai`    |
| `--force`, `--refresh`, `--no-cache` | Force refresh, ignore cache                    | -       |
| `--state <states>`            | Filter by state (comma-separated)                     | -       |
| `--severity <sev>`            | Filter by severity (comma-separated)                  | -       |
| `--changes-from <date>`       | Show changes from this date (ISO format)              | -       |
| `--changes-to <date>`         | Show changes up to this date (ISO format)             | -       |
| `--download-workitems`        | With `--query`: download all work items to tasks/     | -       |
| `--category <name>`           | Save to tasks/<category>/ (remembered per work item)  | -       |
| `--task-folders`              | Save in tasks/<id>/ subfolder (only for new files)    | -       |
| `--help`                      | Show help message                                     | -       |

### Create Options

| Option                  | Description                                           | Default |
| ----------------------- | ----------------------------------------------------- | ------- |
| `-i`, `--interactive`   | Interactive mode with step-by-step prompts            | -       |
| `--from-file <path>`    | Create from template JSON file                        | -       |
| `--type <type>`         | Work item type (Bug, Task, User Story, etc.)          | -       |
| `--title <text>`        | Work item title (for quick non-interactive creation)  | -       |
| `--tags <tags>`         | Tags (comma-separated)                                | -       |
| `--assignee <email>`    | Assignee email                                        | -       |
| `--parent <id>`         | Parent work item ID                                   | -       |

## First-Time Setup

### Prerequisites

1. **Install Azure CLI**: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

2. **Install Azure DevOps extension**:
   ```bash
   az extension add --name azure-devops
   ```

3. **Login with device code** (recommended for corporate environments):
   ```bash
   az login --allow-no-subscriptions --use-device-code
   ```
   This will:
   - Display a code and URL
   - Open the URL in your browser
   - Enter the code to authenticate

### Configure for Your Project

Run with any Azure DevOps URL from your project:

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."
```

This auto-detects:
- Organization URL
- Project name
- Project ID (fetched via API)

Configuration is saved to `.claude/azure/config.json` in your project directory.

## Storage Structure

### Global Cache

```
~/.genesis-tools/azure-devops/
└── cache/
    ├── query-{id}.json           # Query cache (180 days TTL)
    ├── workitem-{id}.json        # Work item cache (5 min TTL)
    └── dashboard-{id}.json       # Dashboard cache
```

### Project Storage

```
{your-project}/
└── .claude/azure/
    ├── config.json               # Project configuration
    └── tasks/
        ├── {id}-{Slug-Title}.json      # Flat structure (default)
        ├── {id}-{Slug-Title}.md
        ├── {id}/                        # Task folder structure (--task-folders)
        │   ├── {id}-{Slug-Title}.json
        │   └── {id}-{Slug-Title}.md
        └── {category}/                  # Category subdirectory (--category)
            ├── {id}-{Slug-Title}.json
            └── {id}/                    # Task folder in category
                └── {id}-{Slug-Title}.json
```

**Config Search**: The tool searches for `.claude/azure/config.json` starting from the current directory, then up to 3 parent levels. This allows running the tool from subdirectories.

## Output Formats

### AI Format (Default)

Optimized for AI consumption with:
- Summary tables
- Change detection highlights
- Actionable next steps
- Relative timestamps

Example:
```
# Query Results: d6e14134-9d22-4cbb-b897-b1514f888667

Last checked: 5 minutes ago

Total: 12 work items

| ID | Title | State | Severity | Assignee |
|-----|-------|-------|----------|----------|
| 12345 | Fix login bug | Active | A | John Doe |
...

## Changes Detected (2)

### NEW: #12346 - Add dark mode
- State: New
- Severity: B
- Assignee: unassigned

### UPDATED: #12345 - Fix login bug
- State: Active → Development
- Assignee: unassigned → John Doe
```

### Markdown Format

Clean markdown tables suitable for documentation:

```markdown
| ID | Title | State | Severity | Assignee |
|---|---|---|---|---|
| 12345 | Fix login bug | Active | A | John Doe |
```

### JSON Format

Raw JSON data for programmatic use:

```json
{
  "items": [...],
  "changes": [...]
}
```

## Features Explained

### Work Item Caching (5-minute TTL)

Work items are cached for 5 minutes to reduce API calls. When using cached data, the output shows:

```
📦 From cache (2 minutes ago) - use --force to refresh
```

Use `--force` or `--refresh` to bypass cache and fetch fresh data.

### Query Change Detection

When you run a query multiple times, the tool automatically detects:

- **New Items**: Work items added to the query since last run
- **Updated Items**: Changes to:
  - State (e.g., Active → Development)
  - Assignee
  - Severity
  - Title
  - Comments (detected via revision number)

Changes are highlighted in the AI format output with before/after values.

### Relations

Work items display related items when available:
- **Parent**: Parent work item (if part of hierarchy)
- **Children**: Child work items
- **Related**: Related work items

Relations are parsed from the work item API response - no extra API calls needed.

### Task Files

Work items are automatically saved to `.claude/azure/tasks/` with slugified filenames:
- `{id}-{title-slug}.json` - Full JSON data with all fields
- `{id}-{title-slug}.md` - Human-readable markdown with formatted description and comments

Files are created/updated whenever you fetch a work item.

### Batch Download

Use `--download-workitems` with `--query` to download all work items from a query:

```bash
tools azure-devops --query <id> --download-workitems
```

This:
1. Fetches the query results
2. For each work item, fetches full details (comments, relations)
3. Saves each item as JSON and Markdown files

### Categories

Organize work items into subdirectories using `--category`:

```bash
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes
```

**Category Memory**: The category is **remembered per work item** in the global cache. Future fetches of the same work item will automatically use the same category, even without specifying `--category` again.

### Task Folders

Use `--task-folders` to save each work item in its own subfolder:

```bash
tools azure-devops --workitem 12345 --task-folders
# Creates: tasks/12345/12345-Task-Title.json

tools azure-devops --query <id> --download-workitems --category react19 --task-folders
# Creates: tasks/react19/12345/12345-Task-Title.json
```

**Important**: Task folders only apply to **new files**. If a work item already exists somewhere (flat or in folder), it stays in its current location. This prevents accidental reorganization of existing files.

### Work Item Creation

The `--create` command supports multiple modes for creating new work items:

#### Interactive Mode

Step-by-step guided creation with project selection, field prompts, and back navigation (ESC to go back):

```bash
tools azure-devops --create -i
```

Features:
- Project selection (cached for 30 days)
- Work item type selection with common types shown first
- Required field validation based on work item type
- Tags, assignee, and parent linking support
- Summary review before creation

#### Template-Based Creation

Generate a template from existing data, fill it in, then create:

```bash
# Generate template from a query (analyzes patterns in similar items)
tools azure-devops --create "https://dev.azure.com/.../query/abc" --type Bug

# Generate template from an existing work item (pre-fills fields)
tools azure-devops --create "https://dev.azure.com/.../_workitems/edit/12345"

# Fill the template, then create
tools azure-devops --create --from-file ".claude/azure/tasks/created/template.json"
```

Template files use the schema `azure-devops-workitem-v1` and include field hints with allowed values.

#### Quick Non-Interactive Creation

Create a work item directly from command line:

```bash
tools azure-devops --create --type Task --title "Fix login bug"
tools azure-devops --create --type Bug --title "Error in checkout" --severity "A - critical" --tags "frontend,urgent"
```

### Change Filtering

Filter query changes by date range to focus on recent activity:

```bash
# Show changes from a specific date
tools azure-devops --query <id> --changes-from 2026-01-24

# Show changes within a date range
tools azure-devops --query <id> --changes-from 2026-01-20 --changes-to 2026-01-25
```

Dates should be in ISO format (YYYY-MM-DD).

## Workflow Examples

### Daily Standup Preparation

```bash
# Fetch your active work items query
tools azure-devops --query <your-active-items-query-id>

# Review changes since yesterday
# Tool automatically highlights new/updated items

# Get full details for items that changed
tools azure-devops --workitem 12345,12346 --force
```

### Sprint Planning

```bash
# Download all items from sprint backlog query
tools azure-devops --query <sprint-query-id> --download-workitems --category sprint-2024-01

# Filter by severity for prioritization
tools azure-devops --query <sprint-query-id> --severity A,B --download-workitems --category sprint-2024-01
```

### Bug Triage

```bash
# Get dashboard with all bug queries
tools azure-devops --dashboard <bugs-dashboard-id>

# Download active bugs
tools azure-devops --query <active-bugs-query-id> --state Active --download-workitems --category bugs

# Organize critical bugs separately
tools azure-devops --query <critical-bugs-query-id> --severity A --download-workitems --category critical-bugs --task-folders
```

### Feature Development

```bash
# Download feature work items
tools azure-devops --query <feature-query-id> --download-workitems --category react19 --task-folders

# Files are organized as:
# tasks/react19/12345/12345-Feature-Title.json
# tasks/react19/12345/12345-Feature-Title.md

# Later, fetch updates (category remembered automatically)
tools azure-devops --workitem 12345 --force
```

## Configuration Reference

The config file (`.claude/azure/config.json`) contains:

```json
{
  "org": "https://dev.azure.com/MyOrg",
  "project": "MyProject",
  "projectId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "apiResource": "499b84ac-1321-427f-aa17-267ca6975798"
}
```

- **org**: Organization URL (extracted from your Azure DevOps URL)
- **project**: Project name (URL-decoded)
- **projectId**: Project GUID (fetched via API during configure)
- **apiResource**: Azure DevOps OAuth resource ID (constant, same for all orgs)

## Troubleshooting

### "No Azure DevOps configuration found"

Run the configure command with any Azure DevOps URL from your project:

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
```

### "Azure CLI Authentication Required"

Ensure you're logged in:

```bash
az login --allow-no-subscriptions --use-device-code
```

### SSL Issues (Proxy/Corporate Environments)

If SSL errors occur:
1. Close Proxyman/proxy tools
2. Or use: `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1 az ...`

### "Failed to get project info"

- Verify your Azure CLI is authenticated: `az account show`
- Check that the project name matches exactly (case-sensitive)
- Ensure you have access to the project

### Cache Issues

- Use `--force` to bypass cache
- Clear cache manually: Delete `~/.genesis-tools/azure-devops/cache/`
- Work item cache expires after 5 minutes automatically
- Query cache expires after 180 days

### Task Files Not Found

The tool searches for task files in:
1. Root tasks directory: `.claude/azure/tasks/`
2. Category subdirectories: `.claude/azure/tasks/{category}/`
3. Task folders: `.claude/azure/tasks/{id}/` or `.claude/azure/tasks/{category}/{id}/`

If a file was moved manually, the tool will create a new one in the expected location based on current settings.

## Architecture

### Caching Strategy

- **Query Cache**: 180-day TTL, stores query results for change detection
- **Work Item Cache**: 5-minute TTL, stores work item metadata (not full data)
- **Dashboard Cache**: 180-day TTL, stores dashboard query list

### Change Detection Algorithm

1. Load previous cache (if exists)
2. Fetch current data from API
3. Compare items by ID:
   - New items: Present in current but not in cache
   - Updated items: Changed date or revision number increased
4. Detect field changes: state, assignee, severity, title
5. Generate change summary

### File Organization Logic

1. **Check Existing**: Search for file in all possible locations
2. **Respect Existing**: If file exists, keep it where it is
3. **Apply Settings**: For new files, use:
   - Category from args → cache → none
   - Task folder from args → cache → false
4. **Cleanup**: Remove old files if path changed (different slug/category/folder)

## Dependencies

- **Azure CLI**: Required for authentication and API access
- **Azure DevOps Extension**: `az extension add --name azure-devops`
- **Bun**: Runtime environment
- **Storage Utility**: Uses `src/utils/storage.ts` for global cache management

## Claude AI Skill

This tool includes a Claude AI skill that enables AI assistants to automatically use the Azure DevOps tool when users ask about work items, queries, or tasks.

### Installing the Skill

Install the skill for Claude AI (Codex/Cursor):

```bash
# Using skill-installer (if available)
tools skill-installer install azure-devops

# Or manually copy the skill file
cp skills/azure-devops.skill ~/.codex/skills/
```

The skill automatically triggers when users mention:
- "get workitem", "fetch task", "show query"
- "download tasks", "analyze workitem", "analyze task"
- Azure DevOps URLs

### Skill Features

- **Automatic Tool Invocation**: AI assistants automatically use `tools azure-devops` when relevant
- **Work Item Analysis**: Can spawn codebase exploration agents to analyze work items
- **Query Handling**: Automatically fetches and processes query results
- **Task Organization**: Handles category and folder organization automatically

## TimeLog Commands

The TimeLog feature integrates with the third-party TimeLog extension for Azure DevOps.

### Prerequisites

1. TimeLog extension must be installed in your Azure DevOps organization
2. Run auto-configuration to fetch TimeLog settings:

```bash
tools azure-devops timelog configure
```

This automatically fetches the API key from Azure DevOps Extension Data API and saves it to `.claude/azure/config.json`.

Then add your user info to the config:

```json
{
  "timelog": {
    "functionsKey": "<auto-fetched>",
    "defaultUser": {
      "userId": "<your-azure-ad-object-id>",
      "userName": "<Your Display Name>",
      "userEmail": "<your-email@example.com>"
    }
  }
}
```

### Commands

```bash
# Auto-configure TimeLog API key
tools azure-devops timelog configure

# List available time types
tools azure-devops timelog types
tools azure-devops timelog types --format json

# List time logs for a work item
tools azure-devops timelog list -w 268935
tools azure-devops timelog list -w 268935 --format md

# Add time log entry (quick)
tools azure-devops timelog add -w 268935 -h 2 -t "Development"
tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
tools azure-devops timelog add -w 268935 -h 0 -m 30 -t "Test"

# Add time log entry (interactive)
tools azure-devops timelog add -i
tools azure-devops timelog add -w 268935 -i

# Bulk import from JSON file
tools azure-devops timelog import entries.json
tools azure-devops timelog import entries.json --dry-run
```

### Import File Format

```json
{
  "entries": [
    {
      "workItemId": 268935,
      "hours": 2,
      "timeType": "Development",
      "date": "2026-02-04",
      "comment": "Implemented feature X"
    },
    {
      "workItemId": 268936,
      "hours": 1,
      "minutes": 30,
      "timeType": "Code Review",
      "date": "2026-02-04",
      "comment": "PR #123 review"
    }
  ]
}
```

### Hours vs Minutes

The TimeLog API uses minutes internally:
- `--hours 2` → 120 minutes
- `--hours 1 --minutes 30` → 90 minutes
- `--minutes 30` → ERROR (ambiguous)
- `--hours 0 --minutes 30` → 30 minutes (explicit)

## Related Tools

- `mcp-manager`: Manage MCP server configurations
- `mcp-tsc`: TypeScript diagnostics MCP server
- `mcp-ripgrep`: Code search MCP server
- `git-last-commits-diff`: View git changes for work items

## Documentation

- [Azure DevOps CLI Reference](https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops)
- [Azure CLI Installation](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)

# Azure DevOps Work Item Tool

CLI tool for fetching and tracking Azure DevOps work items with change detection.

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

### Configure for Your Project

Run with any Azure DevOps URL from your project:

```bash
tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."
```

This auto-detects org, project, and projectId from the URL and saves to `.claude/azure/config.json`.

## Quick Start

```bash
# Get dashboard queries
tools azure-devops --dashboard <url|id>

# Fetch query with change detection
tools azure-devops --query <url|id>

# Filter query by state or severity
tools azure-devops --query <id> --state Active,Development
tools azure-devops --query <id> --severity A,B

# Get full work item + comments + relations (cached 5 min)
tools azure-devops --workitem <url|id>

# Fetch multiple work items
tools azure-devops --workitem 12345,12346,12347

# Force refresh (bypass cache)
tools azure-devops --workitem <id> --force

# Download all work items from a query to tasks/
tools azure-devops --query <id> --download-workitems
tools azure-devops --query <id> --state Active --download-workitems

# Organize by category (remembered for future fetches)
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes

# Use task folders (each task in its own subfolder)
tools azure-devops --workitem 12345 --task-folders
tools azure-devops --query <id> --download-workitems --category react19 --task-folders

# List all cached work items
tools azure-devops --list
```

## Storage Structure

```
~/.genesis-tools/azure-devops/     # Global cache (180 days TTL)
├── cache/
│   ├── query-{id}.json           # Query cache for change detection
│   ├── workitem-{id}.json        # Work item cache (5-min TTL)
│   └── dashboard-{id}.json       # Dashboard cache

{your-project}/                    # Per-project (in cwd)
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

**Config search**: The tool searches for `.claude/azure/config.json` starting from the current directory, then up to 3 parent levels. This allows running the tool from subdirectories.

## Output Formats

- `--format ai` (default): AI-optimized summary with change detection
- `--format md`: Markdown table
- `--format json`: Raw JSON

## Features

### Work Item Caching (5-min TTL)
Work items are cached for 5 minutes. Shows "📦 From cache" when using cached data.
Use `--force` to bypass cache.

### Query Change Detection
When you run a query multiple times, the tool detects:
- New work items added to the query
- Changes to existing items (state, assignee, severity, title)

### Relations
Work items display related items (Parent, Children, Related) when available.
No extra API calls needed - relations are included in the work item response.

### Task Files
Work items are saved to `.claude/azure/tasks/` with slugified filenames:
- `{id}-{title-slug}.json` - Full JSON data
- `{id}-{title-slug}.md` - Human-readable markdown

### Batch Download
Use `--download-workitems` with `--query` to download all work items from a query:
```bash
tools azure-devops --query <id> --download-workitems
```
This fetches full details (comments, relations) for each item and saves to tasks/.

### Categories
Organize work items into subdirectories using `--category`:
```bash
tools azure-devops --query <id> --download-workitems --category react19
tools azure-devops --workitem 12345 --category hotfixes
```
The category is **remembered per work item** in the global cache. Future fetches of the same work item will automatically use the same category, even without specifying `--category` again.

### Task Folders
Use `--task-folders` to save each work item in its own subfolder:
```bash
tools azure-devops --workitem 12345 --task-folders
# Creates: tasks/12345/12345-Task-Title.json

tools azure-devops --query <id> --download-workitems --category react19 --task-folders
# Creates: tasks/react19/12345/12345-Task-Title.json
```

**Important:** Task folders only apply to **new files**. If a work item already exists somewhere (flat or in folder), it stays in its current location. This prevents accidental reorganization of existing files.

## SSL Issues (Proxy/Corporate Environments)

If SSL errors occur:
1. Close Proxyman/proxy tools
2. Or use: `AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1 az ...`

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

## Documentation

- [Azure DevOps CLI Reference](https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops)
- [Azure CLI Installation](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)

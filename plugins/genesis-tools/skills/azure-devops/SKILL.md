---
name: genesis-tools:azure-devops
description: Interact with Azure DevOps work items, queries, and dashboards. Use when user asks to get/fetch/show work items, queries, tasks, bugs from Azure DevOps. Also handles analyzing work items by spawning codebase exploration agents and creating analysis documents. Triggers on phrases like "get workitem", "fetch task", "show query", "download tasks", "analyze workitem", "analyze task", or Azure DevOps URLs.
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
tools azure-devops workitem-create                        # Create work item
tools azure-devops timelog add|list|types        # Time logging (placeholder)
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

### Output Paths

- **Tasks**: `.claude/azure/tasks/` → `<id>-<Slug-Title>.md`
- With `--category react19`: `.claude/azure/tasks/react19/<id>-<Slug>.md`
- With `--task-folders`: `.claude/azure/tasks/<id>/<id>-<Slug>.md`

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

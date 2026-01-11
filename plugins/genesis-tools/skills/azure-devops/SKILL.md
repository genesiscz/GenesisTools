---
name: azure-devops
description: Interact with Azure DevOps work items, queries, and dashboards. Use when user asks to get/fetch/show work items, queries, tasks, bugs from Azure DevOps. Also handles analyzing work items by spawning codebase exploration agents and creating analysis documents. Triggers on phrases like "get workitem", "fetch task", "show query", "download tasks", "analyze workitem", "analyze task", or Azure DevOps URLs.
---

# Azure DevOps Work Item Tool

Fetch, manage, and analyze Azure DevOps work items using `tools azure-devops`.

## CLI Reference

```bash
tools azure-devops --workitem <id|ids>           # Fetch work item(s)
tools azure-devops --query <id|url>              # Fetch query results
tools azure-devops --query <id> --download-workitems  # Download all to files
tools azure-devops --dashboard <id|url>          # Get dashboard queries
tools azure-devops --list                        # List cached items
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
tools azure-devops --workitem 261575
tools azure-devops --workitem 261575,261576,261577
tools azure-devops --workitem 261575 --category react19
tools azure-devops --workitem 261575 --force
```

### Fetch Query

```bash
tools azure-devops --query d6e14134-9d22-4cbb-b897-b1514f888667
tools azure-devops --query <id> --state Active,Development
tools azure-devops --query <id> --download-workitems --category react19
```

### Analyze Work Items

When user says "analyze workitem/task X" or "analyze tasks from query Y":

1. Fetch work item(s):
   ```bash
   tools azure-devops --workitem <ids> --category <cat> --task-folders
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
| "Get workitem 261575" | `tools azure-devops --workitem 261575` |
| "Show query results for X" | `tools azure-devops --query X` |
| "Download React19 bugs" | `tools azure-devops --query <id> --download-workitems --category react19` |
| "Analyze task 261575" | Fetch → Explore agent → Write .analysis.md |
| "Analyze all active bugs" | Fetch query with --download-workitems → Parallel Explore agents → Write .analysis.md files |

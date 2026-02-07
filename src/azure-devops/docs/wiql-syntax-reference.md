# WIQL (Work Item Query Language) Syntax Reference

> Complete reference for Azure DevOps WIQL queries

**Limit:** WIQL queries must not exceed 32K characters.

## Basic Structure

```sql
SELECT
    [System.Id],
    [System.Title],
    [System.State]
FROM workitems
WHERE
    [System.TeamProject] = @project
    AND [System.WorkItemType] = 'User Story'
    AND [System.State] = 'Active'
ORDER BY [System.ChangedDate] DESC
ASOF '2025-01-01'
```

| Clause | Description |
|--------|-------------|
| `SELECT` | Fields to return (friendly name or reference name) |
| `FROM` | `WorkItems` or `workItemLinks` |
| `WHERE` | Filter conditions |
| `ORDER BY` | Sort order (`ASC` or `DESC`) |
| `ASOF` | Historical query - filter as of a specific date |

---

## Operators by Field Type

| Field Type | Operators |
|------------|-----------|
| `Boolean` | `=`, `<>`, `=[Field]`, `<>[Field]` |
| `DateTime` | `=`, `<>`, `>`, `<`, `>=`, `<=`, `In`, `Not In`, `Was Ever` |
| `Integer/Double` | `=`, `<>`, `>`, `<`, `>=`, `<=`, `In`, `Not In`, `Was Ever` |
| `Identity` | `=`, `<>`, `Contains`, `In`, `In Group`, `Not In Group`, `Was Ever` |
| `String` | `=`, `<>`, `Contains`, `Not Contains`, `In`, `Not In`, `Was Ever` |
| `PlainText` | `Contains Words`, `Not Contains Words`, `Is Empty`, `Is Not Empty` |
| `TreePath` | `=`, `<>`, `In`, `Not In`, `Under`, `Not Under` |

---

## Macros/Variables

| Macro | Description | Example |
|-------|-------------|---------|
| `@Me` | Current user | `[System.AssignedTo] = @Me` |
| `@Project` | Current project | `[System.TeamProject] = @Project` |
| `@Today` | Current date (midnight) | `[System.CreatedDate] >= @Today - 7` |
| `@CurrentIteration` | Current sprint for team | `[System.IterationPath] = @CurrentIteration` |
| `@StartOfDay` | Start of current day | `[System.ChangedDate] >= @StartOfDay` |
| `@StartOfWeek` | Start of current week | `[System.ChangedDate] >= @StartOfWeek` |
| `@StartOfMonth` | Start of current month | `[System.ChangedDate] >= @StartOfMonth - 3` |
| `@StartOfYear` | Start of current year | `[System.ChangedDate] >= @StartOfYear` |

### Date Math Examples

```sql
-- Items created in last 7 days
WHERE [System.CreatedDate] >= @Today - 7

-- Items changed since start of month, minus 3 months
WHERE [System.ChangedDate] >= @StartOfMonth - 3

-- Items closed in first 3 months of last year
WHERE [Microsoft.VSTS.Common.ClosedDate] >= @StartOfYear('+3M') - 1
```

---

## Common Query Patterns

### Find Active Items Assigned to Me

```sql
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] = 'Task'
  AND [System.State] = 'Active'
  AND [System.AssignedTo] = @Me
```

### Find Items EVER Assigned to Someone

```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @project
  AND EVER [System.AssignedTo] = 'user@example.com'
```

### Find Items Under Area Path

```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.AreaPath] UNDER 'MyProject\Server\Administration'
```

### Find Items NOT Under Area Path

```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @project
  AND NOT [System.AreaPath] UNDER 'MyProject\Archive'
```

### Find Items in Multiple States (IN operator)

```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.State] IN ('Active', 'In Progress', 'Committed')
```

### Find Items Created by Multiple Users

```sql
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.CreatedBy] IN ('user1@example.com', 'user2@example.com')
```

---

## ASOF - Historical Queries

Query work items as they existed at a specific point in time.

```sql
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.TeamProject] = @project
  AND [System.State] = 'Active'
  AND [System.AssignedTo] = 'user@example.com'
ASOF '2025-01-01T00:00:00Z'
```

### Date Formats

```sql
-- Local time (uses client timezone)
ASOF '01-15-2025 12:00:00'

-- ISO 8601 (recommended)
ASOF '2025-01-15T12:00:00.0000000'

-- UTC
ASOF '2025-01-15T00:00:00Z'
```

**Important:** ASOF returns work items as they were at that date - if an item was later moved or reassigned, you see its old state.

---

## Link Queries (workItemLinks)

Query relationships between work items.

```sql
SELECT [System.Id], [System.Title]
FROM workItemLinks
WHERE
    ([Source].[System.TeamProject] = @project
     AND [Source].[System.WorkItemType] = 'User Story')
    AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
    AND ([Target].[System.WorkItemType] = 'Task'
     AND [Target].[System.State] <> 'Closed')
MODE (Recursive)
```

### Link Types

| Link Type | Description |
|-----------|-------------|
| `System.LinkTypes.Hierarchy-Forward` | Parent → Child |
| `System.LinkTypes.Hierarchy-Reverse` | Child → Parent |
| `System.LinkTypes.Related` | Related |
| `System.LinkTypes.Dependency-Predecessor` | Predecessor |
| `System.LinkTypes.Dependency-Successor` | Successor |

### MODE Options

| Mode | Description |
|------|-------------|
| `MustContain` | (Default) Returns only records where source, target, and link all match |
| `MayContain` | Returns source items even if no target matches |
| `DoesNotContain` | Returns source items only if NO target matches |
| `Recursive` | For tree queries - traverses hierarchy |

**Note:** `ORDER BY` and `ASOF` are NOT compatible with tree/recursive queries.

---

## Common Field Reference Names

| Friendly Name | Reference Name |
|---------------|----------------|
| ID | `System.Id` |
| Title | `System.Title` |
| State | `System.State` |
| Assigned To | `System.AssignedTo` |
| Created By | `System.CreatedBy` |
| Created Date | `System.CreatedDate` |
| Changed Date | `System.ChangedDate` |
| Changed By | `System.ChangedBy` |
| Work Item Type | `System.WorkItemType` |
| Area Path | `System.AreaPath` |
| Iteration Path | `System.IterationPath` |
| Tags | `System.Tags` |
| Priority | `Microsoft.VSTS.Common.Priority` |
| Severity | `Microsoft.VSTS.Common.Severity` |
| Remaining Work | `Microsoft.VSTS.Scheduling.RemainingWork` |
| Original Estimate | `Microsoft.VSTS.Scheduling.OriginalEstimate` |
| Completed Work | `Microsoft.VSTS.Scheduling.CompletedWork` |

### Custom Fields

Custom fields use `Custom.` prefix with spaces removed:
- `Approver` → `Custom.Approver`
- `Request Type` → `Custom.RequestType`

---

## REST API Usage

### Query By WIQL

```bash
az rest --method POST \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1" \
  --body '{
    "query": "SELECT [System.Id] FROM workitems WHERE [System.State] = '\''Active'\''"
  }'
```

### Response (IDs only)

```json
{
  "queryType": "flat",
  "asOf": "2025-01-15T00:00:00Z",
  "workItems": [
    { "id": 1, "url": "..." },
    { "id": 2, "url": "..." }
  ]
}
```

### Fetch Full Work Items (after WIQL)

```bash
# Use IDs from WIQL response
az rest --method GET \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems?ids=1,2,3&api-version=7.1"

# With ASOF for historical data
az rest --method GET \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems?ids=1,2,3&asOf=2025-01-01T00:00:00Z&api-version=7.1"
```

---

## Links

- [WIQL Syntax Reference](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax?view=azure-devops)
- [Query Quick Reference](https://learn.microsoft.com/en-us/azure/devops/boards/queries/query-quick-ref?view=azure-devops)
- [Work Item Field Index](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/work-item-field?view=azure-devops)

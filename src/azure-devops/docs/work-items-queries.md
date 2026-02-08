# Work Items Queries Reference (CEZ/col-fe)

> Tested against: `cez-azuredevops` / `MŮJ ČEZ` project

---

## Schema Definitions

### workitems (Main Table)

```sql
-- Main work items table - queryable via WIQL
-- Limit: 20,000 results max per query

CREATE TABLE workitems (
    -- Core Identity Fields
    [System.Id]                     INTEGER PRIMARY KEY,    -- Work item ID
    [System.Rev]                    INTEGER,                -- Revision number
    [System.WorkItemType]           VARCHAR(100),           -- Bug, Task, Feature, User Story, Epic, etc.

    -- Classification
    [System.TeamProject]            VARCHAR(300),           -- Project name (e.g., "MŮJ ČEZ")
    [System.AreaPath]               TREEPATH,               -- Area hierarchy (e.g., "MŮJ ČEZ\Backend")
    [System.AreaId]                 INTEGER,                -- Area node ID
    [System.IterationPath]          TREEPATH,               -- Sprint path (e.g., "MŮJ ČEZ\Sprint 5")
    [System.IterationId]            INTEGER,                -- Iteration node ID

    -- State & Workflow
    [System.State]                  VARCHAR(100),           -- New, Active, Committed, Closed, etc.
    [System.Reason]                 VARCHAR(256),           -- State change reason
    [System.BoardColumn]            VARCHAR(256),           -- Kanban column name
    [System.BoardColumnDone]        BOOLEAN,                -- Is in "Done" split?
    [System.BoardLane]              VARCHAR(256),           -- Kanban swim lane

    -- Content
    [System.Title]                  VARCHAR(256) NOT NULL,  -- Work item title
    [System.Description]            HTML,                   -- Rich text description
    [System.Tags]                   VARCHAR(400),           -- Semicolon-separated tags

    -- People
    [System.AssignedTo]             IDENTITY,               -- Current assignee
    [System.CreatedBy]              IDENTITY,               -- Creator
    [System.ChangedBy]              IDENTITY,               -- Last modifier
    [System.AuthorizedAs]           IDENTITY,               -- Who authorized last change

    -- Timestamps
    [System.CreatedDate]            DATETIME,               -- Creation timestamp
    [System.ChangedDate]            DATETIME,               -- Last modification timestamp
    [System.AuthorizedDate]         DATETIME,               -- Last authorization timestamp
    [System.RevisedDate]            DATETIME,               -- When revision was superseded

    -- Counts
    [System.CommentCount]           INTEGER,                -- Number of comments
    [System.AttachedFileCount]      INTEGER,                -- Number of attachments
    [System.ExternalLinkCount]      INTEGER,                -- External links count
    [System.HyperLinkCount]         INTEGER,                -- Hyperlinks count
    [System.RelatedLinkCount]       INTEGER,                -- Related work items count

    -- Parent/Child
    [System.Parent]                 INTEGER,                -- Parent work item ID

    -- Common VSTS Fields
    [Microsoft.VSTS.Common.Priority]        INTEGER,        -- 1-4 (1=highest)
    [Microsoft.VSTS.Common.Severity]        VARCHAR(100),   -- 1 - Critical, 2 - High, 3 - Medium, 4 - Low
    [Microsoft.VSTS.Common.ValueArea]       VARCHAR(100),   -- Business, Architectural
    [Microsoft.VSTS.Common.Risk]            VARCHAR(100),   -- 1 - High, 2 - Medium, 3 - Low
    [Microsoft.VSTS.Common.ActivatedBy]     IDENTITY,       -- Who activated
    [Microsoft.VSTS.Common.ActivatedDate]   DATETIME,       -- When activated
    [Microsoft.VSTS.Common.ClosedBy]        IDENTITY,       -- Who closed
    [Microsoft.VSTS.Common.ClosedDate]      DATETIME,       -- When closed
    [Microsoft.VSTS.Common.ResolvedBy]      IDENTITY,       -- Who resolved
    [Microsoft.VSTS.Common.ResolvedDate]    DATETIME,       -- When resolved
    [Microsoft.VSTS.Common.StateChangeDate] DATETIME,       -- Last state transition
    [Microsoft.VSTS.Common.StackRank]       DOUBLE,         -- Backlog priority order

    -- Scheduling
    [Microsoft.VSTS.Scheduling.OriginalEstimate]  DOUBLE,   -- Original work estimate (hours)
    [Microsoft.VSTS.Scheduling.RemainingWork]     DOUBLE,   -- Remaining work (hours)
    [Microsoft.VSTS.Scheduling.CompletedWork]     DOUBLE,   -- Completed work (hours)
    [Microsoft.VSTS.Scheduling.StartDate]         DATETIME, -- Planned start
    [Microsoft.VSTS.Scheduling.FinishDate]        DATETIME, -- Planned finish
    [Microsoft.VSTS.Scheduling.Effort]            DOUBLE,   -- Story points

    -- Acceptance Criteria
    [Microsoft.VSTS.Common.AcceptanceCriteria]    HTML      -- Rich text acceptance criteria
);
```

### workItemLinks (Relationships Table)

```sql
-- Links between work items - queried via FROM workItemLinks
-- Used for parent/child, predecessor/successor, related relationships

CREATE TABLE workItemLinks (
    [Source].[<any_field>]          -- Source work item fields
    [Target].[<any_field>]          -- Target work item fields
    [System.Links.LinkType]         VARCHAR(100)            -- Link type reference name
);

-- Link Types Available:
-- 'System.LinkTypes.Hierarchy-Forward'     -- Parent → Child
-- 'System.LinkTypes.Hierarchy-Reverse'     -- Child → Parent
-- 'System.LinkTypes.Related'               -- Related items
-- 'System.LinkTypes.Dependency-Predecessor'-- Predecessor
-- 'System.LinkTypes.Dependency-Successor'  -- Successor
-- 'Microsoft.VSTS.Common.Affects-Forward'  -- Affects
-- 'Microsoft.VSTS.Common.Affects-Reverse'  -- Affected By
```

### CEZ Custom Fields

```sql
-- Custom fields specific to CEZ/col-fe project
-- Reference names use Custom.* prefix

-- Boolean flags
[Custom.APIdeployment]              BOOLEAN,    -- API deployment required
[Custom.ApprovalRM]                 BOOLEAN,    -- RM approval required

-- String selections
[Custom.Aplikace]                   VARCHAR(256),   -- Application name (Czech)
[Custom.Application]                VARCHAR(256),   -- Application name (English)
[Custom.Applicationsubcategories]   VARCHAR(256),   -- App subcategories
[Custom.ApplicatonorSystem]         VARCHAR(256),   -- App or System
[Custom.AssignedGroup]              VARCHAR(256),   -- Team/Group assignment

-- Czech-specific
[Custom.d099ca66-d0ca-4125-813c-773ff61eeab3]   VARCHAR(256),   -- Číslo SD
[Custom.d3a5f967-2afb-4070-8bd0-e3b5ec50fab5]   VARCHAR(256),   -- Číslo transportu
[Custom.aececa28-281f-42f2-95f5-d3898b867d7f]   VARCHAR(256),   -- Bezpečnostně významná změna
```

### Work Item Types (CEZ)

```sql
-- Available work item types in cez-azuredevops/MŮJ ČEZ

-- Agile Process
'Bug'               -- Defect tracking
'Epic'              -- Large feature grouping
'Feature'           -- Releasable functionality
'User Story'        -- User-facing requirement
'Task'              -- Work breakdown unit
'Issue'             -- Impediment tracking

-- Custom Types
'BN'                -- Business Need (CEZ custom)
'JDZ Task'          -- JDZ-specific task (CEZ custom)
'Incident'          -- Incident tracking (CEZ custom)
'Deployment'        -- Deployment tracking (CEZ custom)

-- Testing
'Test Plan'         -- Test plan container
'Test Suite'        -- Test case grouping
'Test Case'         -- Individual test
'Shared Steps'      -- Reusable test steps
'Shared Parameter'  -- Parameterized test data

-- Code Review
'Code Review Request'   -- CR request
'Code Review Response'  -- CR response

-- Feedback
'Feedback Request'      -- Feedback solicitation
'Feedback Response'     -- Feedback provided
```

---

## WIQL Query Patterns (Verified Working)

### Basic Queries

```sql
-- Get active work items with core fields
-- ✅ VERIFIED
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
FROM workitems
WHERE [System.State] = 'Active'

-- Get items with multiple fields (extended)
-- ✅ VERIFIED
SELECT
    [System.Id],
    [System.Title],
    [System.State],
    [System.AssignedTo],
    [System.CreatedDate],
    [System.ChangedDate],
    [System.CreatedBy],
    [System.ChangedBy],
    [System.WorkItemType],
    [System.AreaPath],
    [System.IterationPath]
FROM workitems
WHERE [System.State] = 'Active'
```

### Filtering by State

```sql
-- Multiple states with IN operator
-- ✅ VERIFIED
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.State] IN ('Active', 'New', 'Committed')

-- Exclude states with NOT IN
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.State] NOT IN ('Closed', 'Removed')
```

### Date Filtering

```sql
-- Items changed in last 7 days
-- ✅ VERIFIED
SELECT [System.Id], [System.Title], [System.ChangedDate]
FROM workitems
WHERE [System.ChangedDate] >= @Today - 7

-- Items created this month
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.CreatedDate] >= @StartOfMonth

-- Items changed this week
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.ChangedDate] >= @StartOfWeek
```

### Identity/User Queries

```sql
-- Items assigned to current user
-- ✅ VERIFIED
SELECT [System.Id], [System.Title], [System.AssignedTo]
FROM workitems
WHERE [System.AssignedTo] = @Me

-- Items created by specific user
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.CreatedBy] = 'user@example.com'

-- Items changed by multiple users
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.ChangedBy] IN ('user1@example.com', 'user2@example.com')
```

### Text Search

```sql
-- Title contains text (case-insensitive)
-- ✅ VERIFIED
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.Title] CONTAINS 'login'

-- Title does not contain
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.Title] NOT CONTAINS 'test'

-- Description/PlainText fields use CONTAINS WORDS
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.Description] CONTAINS WORDS 'authentication error'
```

### Area and Iteration Paths

```sql
-- Items UNDER area path (includes all children)
-- ✅ VERIFIED (Note: returns 20k+ items for root)
SELECT [System.Id], [System.Title], [System.AreaPath]
FROM workitems
WHERE [System.AreaPath] UNDER 'MŮJ ČEZ\Backend'

-- Items NOT under specific area
SELECT [System.Id], [System.Title]
FROM workitems
WHERE NOT [System.AreaPath] UNDER 'MŮJ ČEZ\Archive'

-- Exact iteration path match
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.IterationPath] = 'MŮJ ČEZ\Sprint 5'
```

### Historical Queries (ASOF)

```sql
-- Get work items AS OF specific date
-- Shows state of items at that point in time
-- ✅ VERIFIED
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.State] = 'Active'
ASOF '2024-01-01'

-- ASOF with ISO 8601 format (recommended)
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.State] = 'Active'
ASOF '2024-01-01T00:00:00Z'

-- ASOF returns items as they existed at that date
-- If an item was later moved/closed, you see its old state
```

### Historical Field Changes (EVER)

```sql
-- Items EVER in a specific state
-- Searches entire revision history
-- ⚠️ Can return 20k+ items - add filters
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE EVER [System.State] = 'Closed'
  AND [System.WorkItemType] = 'Bug'

-- Items EVER assigned to someone
SELECT [System.Id], [System.Title]
FROM workitems
WHERE EVER [System.AssignedTo] = 'user@example.com'
  AND [System.ChangedDate] >= @Today - 30
```

### Work Item Type Queries

```sql
-- Specific type
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.WorkItemType] = 'Bug'
  AND [System.State] = 'Active'

-- Multiple types
SELECT [System.Id], [System.Title], [System.WorkItemType]
FROM workitems
WHERE [System.WorkItemType] IN ('Bug', 'Task', 'User Story')

-- CEZ custom types
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [System.WorkItemType] = 'JDZ Task'
```

### Priority/Severity Queries

```sql
-- High priority bugs
SELECT [System.Id], [System.Title], [Microsoft.VSTS.Common.Priority]
FROM workitems
WHERE [System.WorkItemType] = 'Bug'
  AND [Microsoft.VSTS.Common.Priority] <= 2
  AND [System.State] <> 'Closed'

-- Critical severity
SELECT [System.Id], [System.Title]
FROM workitems
WHERE [Microsoft.VSTS.Common.Severity] = '1 - Critical'
```

### Sorting and Ordering

```sql
-- Order by changed date descending
SELECT [System.Id], [System.Title], [System.ChangedDate]
FROM workitems
WHERE [System.State] = 'Active'
ORDER BY [System.ChangedDate] DESC

-- Multiple sort columns
SELECT [System.Id], [System.Title], [System.State]
FROM workitems
WHERE [System.WorkItemType] = 'Bug'
ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC
```

---

## Link Queries (Parent/Child Relationships)

```sql
-- Get Features with their child User Stories
-- Note: Returns empty if no matches
SELECT [System.Id], [System.Title]
FROM workItemLinks
WHERE
    ([Source].[System.WorkItemType] = 'Feature')
    AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
    AND ([Target].[System.WorkItemType] = 'User Story')
MODE (MustContain)

-- MODE Options:
-- MustContain  - (Default) All conditions must match
-- MayContain   - Return source even if no target matches
-- DoesNotContain - Return source only if NO target matches
-- Recursive    - Traverse full hierarchy tree

-- ⚠️ ASOF and ORDER BY are NOT compatible with link queries
```

---

## REST API for History & Comments

### Get Work Item Updates (Field Changes)

```bash
# Get all revisions/updates for a work item
# Shows oldValue/newValue for each field change per revision
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}/updates?api-version=7.0"

# Example output structure:
# {
#   "count": 15,
#   "value": [
#     {
#       "id": 1,
#       "rev": 1,
#       "revisedBy": { "displayName": "User Name" },
#       "revisedDate": "2020-01-07T09:16:05.147Z",
#       "fields": {
#         "System.State": { "oldValue": null, "newValue": "New" },
#         "System.AssignedTo": { "oldValue": null, "newValue": {...} }
#       }
#     }
#   ]
# }
```

### Get Work Item Comments

```bash
# Get comments for a work item
# ⚠️ Requires preview API version
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}/comments?api-version=7.0-preview"

# Example output:
# {
#   "comments": [
#     {
#       "id": 8296099,
#       "text": "<div>Comment HTML content</div>",
#       "createdBy": { "displayName": "User Name" },
#       "createdDate": "2020-05-25T10:19:27.64Z",
#       "modifiedDate": "2020-05-25T10:19:27.64Z"
#     }
#   ],
#   "totalCount": 1
# }
```

### Get Work Item Revisions (Full Snapshots)

```bash
# Get full work item state at each revision
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}/revisions?api-version=7.0"

# Each revision contains the complete work item state at that point
```

### Batch Work Items (Current State)

```bash
# Get up to 200 work items in one call
az rest --method post \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workitemsbatch?api-version=7.0" \
  --body '{"ids": [1, 2, 3], "fields": ["System.Id", "System.Title", "System.State"]}'
```

---

## Macros Reference

| Macro | Description | Needs Team Context |
|-------|-------------|-------------------|
| `@Me` | Current authenticated user | No |
| `@Today` | Current date at midnight | No |
| `@Today - N` | N days ago | No |
| `@Project` | Current project name | No |
| `@StartOfDay` | Start of current day | No |
| `@StartOfWeek` | Start of current week | No |
| `@StartOfMonth` | Start of current month | No |
| `@StartOfYear` | Start of current year | No |
| `@CurrentIteration` | Team's current sprint | **Yes** |
| `@CurrentIteration + N` | N sprints ahead | **Yes** |

**Team Context Error:**
```
ERROR: VS402612: The macro '@CurrentIteration' is not supported without a team context.
```
Solution: Use explicit iteration path or query via REST API with team parameter.

---

## Common Errors & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `VS402337: exceeds size limit of 20000` | Query returns too many results | Add more WHERE filters |
| `VS402612: macro not supported without team` | Using @CurrentIteration | Specify iteration path explicitly |
| `TF51005: permission denied` | No read access to work items | Check project permissions |

---

## CLI Examples

```bash
# Basic query
az boards query --wiql "SELECT [System.Id], [System.Title] FROM workitems WHERE [System.State] = 'Active'"

# Query with output format
az boards query --wiql "..." -o table

# Query specific project (overrides default)
az boards query --wiql "..." --project "MŮJ ČEZ"

# Query with JMESPath filtering
az boards query --wiql "..." --query "[].fields.{ID: 'System.Id', Title: 'System.Title'}"

# Show single work item with all fields
az boards work-item show --id 613

# Show work item in table format
az boards work-item show --id 613 -o table
```

---

## Performance Tips

1. **Always filter by date** when possible - reduces result set significantly
2. **Use ASOF for historical reports** instead of querying all revisions
3. **Avoid `EVER` without date constraints** - searches entire history
4. **Use `NOT [System.AreaPath] UNDER 'Archive'`** to exclude old items
5. **Batch REST API calls** for multiple work items instead of individual calls
6. **Comments API has no batch** - must fetch per work item

---

## Links

- [WIQL Syntax Reference](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax)
- [Work Item Field Index](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/work-item-field)
- [REST API - Work Item Updates](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/updates)
- [REST API - Work Item Comments](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments)

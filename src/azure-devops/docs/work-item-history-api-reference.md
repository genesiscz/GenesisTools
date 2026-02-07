# Azure DevOps Work Item History & Comments API Reference

This document provides a comprehensive reference for Azure DevOps REST APIs related to work item history, revisions, updates, and comments. All APIs use OAuth2 authentication with the `vso.work` scope.

## Table of Contents

1. [Work Item Revisions](#work-item-revisions) - Full snapshots of work items at each revision
2. [Work Item Updates](#work-item-updates) - Delta/changes between revisions
3. [Reporting Work Item Revisions](#reporting-work-item-revisions) - Batch API for syncing multiple work items
4. [Work Item Comments](#work-item-comments) - Comment threads on work items
5. [WIQL Historical Queries](#wiql-historical-queries) - Query work items as of a specific date
6. [Comparison Summary](#api-comparison-summary)

---

## Work Item Revisions

**Purpose:** Get full snapshots of a work item at each revision point. Every revision contains ALL fields (not just changed ones).

### List Revisions (GET)

```http
GET https://dev.azure.com/{organization}/{project}/_apis/wit/workItems/{id}/revisions?api-version=7.1
```

#### URI Parameters

| Name | Required | Type | Description |
|------|----------|------|-------------|
| `organization` | Yes | string | Azure DevOps organization name |
| `project` | No | string | Project ID or name (optional scoping) |
| `id` | Yes | integer | Work item ID |
| `api-version` | Yes | string | Must be `7.1` |

#### Query Parameters

| Name | Type | Description |
|------|------|-------------|
| `$top` | integer | Number of revisions to return (pagination) |
| `$skip` | integer | Number of revisions to skip (pagination) |
| `$expand` | enum | Expansion: `none`, `relations`, `fields`, `links`, `all` |

#### Response Structure

```json
{
  "count": 9,
  "value": [
    {
      "id": 1,
      "rev": 1,
      "fields": {
        "System.WorkItemType": "Bug",
        "System.State": "New",
        "System.Title": "Bug 1",
        "System.CreatedDate": "2017-09-04T02:08:16.6Z",
        "System.CreatedBy": {
          "displayName": "Jamal Hartnett",
          "uniqueName": "fabrikamfiber4@hotmail.com",
          "id": "d291b0c4-a05c-4ea6-8df1-4b41d5f39eff"
        },
        "System.ChangedDate": "2017-09-04T02:08:16.6Z",
        "System.ChangedBy": { /* IdentityRef */ }
      },
      "relations": [],
      "_links": {},
      "url": "https://dev.azure.com/org/project/_apis/wit/workItems/1/revisions/1"
    }
  ]
}
```

#### Usage with `az rest`

```bash
# Get all revisions
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/revisions?api-version=7.1"

# Get revisions with pagination
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/revisions?\$top=10&\$skip=0&api-version=7.1"
```

#### Key Features

- Returns **complete field data** for each revision (not just changed fields)
- Includes `System.ChangedBy` and `System.ChangedDate` for who/when
- Supports pagination with `$top` and `$skip`
- Can expand relations with `$expand=relations`

---

## Work Item Updates

**Purpose:** Get the **deltas** (changes) between work item revisions. Shows what fields changed, with both old and new values.

### List Updates (GET)

```http
GET https://dev.azure.com/{organization}/{project}/_apis/wit/workItems/{id}/updates?api-version=7.1
```

#### URI Parameters

| Name | Required | Type | Description |
|------|----------|------|-------------|
| `organization` | Yes | string | Azure DevOps organization name |
| `project` | No | string | Project ID or name |
| `id` | Yes | integer | Work item ID |
| `api-version` | Yes | string | Must be `7.1` |

#### Query Parameters

| Name | Type | Description |
|------|------|-------------|
| `$top` | integer | Number of updates to return |
| `$skip` | integer | Number of updates to skip |

#### Response Structure

```json
{
  "count": 13,
  "value": [
    {
      "id": 2,
      "workItemId": 1,
      "rev": 2,
      "revisedBy": {
        "id": "d291b0c4-a05c-4ea6-8df1-4b41d5f39eff",
        "displayName": "Jamal Hartnett",
        "uniqueName": "fabrikamfiber4@hotmail.com"
      },
      "revisedDate": "2017-09-04T02:28:56.253Z",
      "fields": {
        "System.State": {
          "oldValue": "New",
          "newValue": "Active"
        },
        "System.AssignedTo": {
          "newValue": {
            "displayName": "Jamal Hartnett",
            "uniqueName": "fabrikamfiber4@hotmail.com"
          }
        },
        "System.History": {
          "newValue": "Moving to active"
        }
      },
      "relations": {
        "added": [
          {
            "rel": "System.LinkTypes.Related",
            "url": "https://dev.azure.com/org/_apis/wit/workItems/10",
            "attributes": { "isLocked": false, "comment": "Related item" }
          }
        ],
        "removed": [],
        "updated": []
      },
      "url": "https://dev.azure.com/org/project/_apis/wit/workItems/1/updates/2"
    }
  ]
}
```

#### Field Update Patterns

**New field (first time set):**
```json
"System.AssignedTo": {
  "newValue": "John Doe <john@example.com>"
}
```

**Modified field:**
```json
"System.State": {
  "oldValue": "New",
  "newValue": "Active"
}
```

**Cleared field:**
```json
"System.AssignedTo": {
  "oldValue": "John Doe <john@example.com>"
}
```

#### Usage with `az rest`

```bash
# Get all updates
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/updates?api-version=7.1"

# Get paginated updates
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/updates?\$skip=5&\$top=10&api-version=7.1"
```

#### Key Features

- Returns **only changed fields** (not all fields)
- Shows both `oldValue` and `newValue` for field changes
- Tracks relation changes: `added`, `removed`, `updated`
- More compact than revisions for change tracking
- **No batch endpoint** - must call per work item

---

## Reporting Work Item Revisions

**Purpose:** Batch API for getting revisions across multiple work items. Designed for sync scenarios and data warehouse population.

### GET Endpoint

```http
GET https://dev.azure.com/{organization}/{project}/_apis/wit/reporting/workitemrevisions?api-version=7.1
```

#### Query Parameters

| Name | Type | Description |
|------|------|-------------|
| `fields` | string[] | Comma-separated field names to return (omit for all) |
| `types` | string[] | Comma-separated work item types (e.g., `Bug,Task`) |
| `continuationToken` | string | Token from previous response for pagination |
| `startDateTime` | date-time | ISO 8601 timestamp to start from (cannot use with token) |
| `includeIdentityRef` | boolean | Return identity objects instead of strings |
| `includeDeleted` | boolean | Include deleted work items |
| `includeTagRef` | boolean | Return tag objects for System.Tags field |
| `includeLatestOnly` | boolean | Only latest revision, skip history |
| `includeDiscussionChangesOnly` | boolean | Only revisions where history changed |
| `$expand` | enum | Include long text fields in response |
| `$maxPageSize` | integer | Maximum results per page |

### POST Endpoint (Recommended for complex filters)

```http
POST https://dev.azure.com/{organization}/{project}/_apis/wit/reporting/workitemrevisions?api-version=7.1
```

#### Request Body

```json
{
  "types": ["Bug", "Task", "Product Backlog Item"],
  "fields": [
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.CreatedBy",
    "System.ChangedBy",
    "System.ChangedDate",
    "System.AreaPath",
    "System.IterationPath"
  ],
  "includeIdentityRef": true,
  "includeDeleted": false,
  "includeLatestOnly": false,
  "includeTagRef": true
}
```

#### Response Structure

```json
{
  "values": [
    {
      "id": 1,
      "rev": 3,
      "fields": {
        "System.Id": 1,
        "System.WorkItemType": "Bug",
        "System.Title": "Bug title",
        "System.State": "Active",
        "System.CreatedBy": "John Doe <john@example.com>",
        "System.ChangedBy": {
          "displayName": "Jane Smith",
          "uniqueName": "jane@example.com",
          "id": "abc-123"
        },
        "System.ChangedDate": "2024-01-15T10:30:00Z"
      }
    }
  ],
  "nextLink": "https://dev.azure.com/org/_apis/wit/reporting/workItemRevisions?continuationToken=813;350;1&api-version=7.1",
  "continuationToken": "813;350;1",
  "isLastBatch": false
}
```

#### Usage with `az rest`

```bash
# GET: Start batch sync
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/reporting/workitemrevisions?includeIdentityRef=true&api-version=7.1"

# GET: Continue with token
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/reporting/workitemrevisions?continuationToken=813;350;1&api-version=7.1"

# POST: Filtered batch
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --method POST \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/reporting/workitemrevisions?api-version=7.1" \
  --body '{
    "types": ["Bug", "Task"],
    "fields": ["System.Id", "System.Title", "System.State"],
    "includeIdentityRef": true
  }'
```

#### Key Features

- **Batch processing** across ALL work items in project/organization
- Efficient for syncing to external systems (Timely, etc.)
- Returns full field data like Revisions API
- Supports continuation tokens for large result sets
- Can filter by work item types
- `includeLatestOnly=true` for current state snapshot
- **No work item ID filtering** - must filter client-side or use Analytics OData

#### Pagination Strategy

```typescript
async function syncAllWorkItems() {
  let continuationToken = null;
  let allRevisions = [];

  do {
    const url = continuationToken
      ? `https://dev.azure.com/{org}/{project}/_apis/wit/reporting/workitemrevisions?continuationToken=${continuationToken}&api-version=7.1`
      : `https://dev.azure.com/{org}/{project}/_apis/wit/reporting/workitemrevisions?includeLatestOnly=false&api-version=7.1`;

    const response = await azRest(url);
    allRevisions.push(...response.values);

    continuationToken = response.continuationToken;
  } while (!response.isLastBatch);

  return allRevisions;
}
```

---

## Work Item Comments

**Purpose:** Get discussion comments on work items (separate from history field changes).

### List Comments (GET)

```http
GET https://dev.azure.com/{organization}/{project}/_apis/wit/workItems/{workItemId}/comments?api-version=7.1-preview.4
```

#### URI Parameters

| Name | Required | Type | Description |
|------|----------|------|-------------|
| `organization` | Yes | string | Azure DevOps organization name |
| `project` | Yes | string | Project ID or name |
| `workItemId` | Yes | integer | Work item ID |
| `api-version` | Yes | string | Must be `7.1-preview.4` (preview API) |

#### Query Parameters

| Name | Type | Description |
|------|------|-------------|
| `$top` | integer | Max number of comments to return |
| `continuationToken` | string | Token for next page |
| `includeDeleted` | boolean | Include deleted comments |
| `$expand` | enum | Options: `none`, `reactions`, `renderedText`, `renderedTextOnly`, `all` |
| `order` | enum | Sort order: `asc` or `desc` |

#### Response Structure

```json
{
  "totalCount": 5,
  "count": 2,
  "comments": [
    {
      "workItemId": 299,
      "commentId": 42,
      "version": 1,
      "text": "Moving to the right area path",
      "renderedText": "<p>Moving to the right area path</p>",
      "format": "markdown",
      "isDeleted": false,
      "createdBy": {
        "displayName": "Jamal Hartnett",
        "uniqueName": "fabrikamfiber4@hotmail.com",
        "id": "d291b0c4-a05c-4ea6-8df1-4b41d5f39eff"
      },
      "createdDate": "2019-01-16T03:03:28.97Z",
      "modifiedBy": { /* IdentityRef */ },
      "modifiedDate": "2019-01-16T03:03:28.97Z",
      "mentions": [],
      "reactions": [
        {
          "type": "like",
          "count": 3,
          "isCurrentUserEngaged": false
        }
      ],
      "url": "https://dev.azure.com/org/project/_apis/wit/workItems/299/comments/42"
    }
  ],
  "continuationToken": "DFkODYtNTYxYS03ZDdiLWJj",
  "nextPage": "https://dev.azure.com/org/project/_apis/wit/workItems/299/comments?continuationToken=DFkODYtNTYxYS03ZDdiLWJj&api-version=7.1-preview.4",
  "url": "https://dev.azure.com/org/project/_apis/wit/workItems/299/comments?api-version=7.1-preview.4"
}
```

### Get Single Comment (GET)

```http
GET https://dev.azure.com/{organization}/{project}/_apis/wit/workItems/{workItemId}/comments/{commentId}?api-version=7.1-preview.4
```

#### Query Parameters

| Name | Type | Description |
|------|------|-------------|
| `includeDeleted` | boolean | Retrieve deleted comment |
| `$expand` | enum | `none`, `reactions`, `renderedText`, `renderedTextOnly`, `all` |

#### Usage with `az rest`

```bash
# List all comments
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4"

# Get single comment
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/comments/{commentId}?api-version=7.1-preview.4"

# Get comments with reactions
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/comments?\$expand=reactions&api-version=7.1-preview.4"
```

#### Key Features

- **Preview API** (version 7.1-preview.4)
- Comments are separate from `System.History` field
- Supports reactions (like, heart, etc.)
- Tracks @mentions
- Markdown format with rendered HTML output
- **No batch endpoint** - must call per work item

---

## WIQL Historical Queries

**Purpose:** Query work items as they existed at a specific point in time using the `ASOF` clause.

### Query By WIQL (POST)

```http
POST https://dev.azure.com/{organization}/{project}/_apis/wit/wiql?api-version=7.1
```

#### Request Body with ASOF

```json
{
  "query": "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.TeamProject] = 'MyProject' AND [System.State] = 'Active' ASOF '2024-01-01T00:00:00Z'"
}
```

#### Example WIQL Queries

**Get work items as of specific date:**
```sql
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems
WHERE [System.TeamProject] = 'MyProject'
  AND [System.State] = 'Active'
  ASOF '2023-12-31T23:59:59Z'
```

**Get work items assigned to user on a date:**
```sql
SELECT [System.Id], [System.Title]
FROM WorkItems
WHERE [System.AssignedTo] = 'john@example.com'
  AND [System.WorkItemType] = 'Task'
  ASOF '2024-01-15T12:00:00Z'
```

#### Response Structure

WIQL only returns **work item IDs**, not field data:

```json
{
  "queryType": "flat",
  "queryResultType": "workItem",
  "asOf": "2024-01-01T00:00:00Z",
  "columns": [
    { "referenceName": "System.Id", "name": "ID", "url": "..." },
    { "referenceName": "System.Title", "name": "Title", "url": "..." }
  ],
  "workItems": [
    { "id": 1, "url": "..." },
    { "id": 2, "url": "..." },
    { "id": 5, "url": "..." }
  ]
}
```

**Important:** After getting IDs, you must call Work Items API with `asOf` parameter:

```http
GET https://dev.azure.com/{org}/{project}/_apis/wit/workItems?ids=1,2,5&asOf=2024-01-01T00:00:00Z&api-version=7.1
```

#### Usage with `az rest`

```bash
# Run WIQL query with ASOF
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --method POST \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1" \
  --body '{
    "query": "SELECT [System.Id] FROM WorkItems WHERE [System.State] = '\''Active'\'' ASOF '\''2024-01-01T00:00:00Z'\''"
  }'

# Get work items as of date (after WIQL)
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "https://dev.azure.com/{org}/{project}/_apis/wit/workItems?ids=1,2,5&asOf=2024-01-01T00:00:00Z&api-version=7.1"
```

#### Key Features

- Query work items **as they existed** at specific timestamp
- Useful for historical reporting and time-based analysis
- Two-step process: WIQL for IDs → Work Items API for data
- ASOF format: ISO 8601 datetime string

---

## API Comparison Summary

| Feature | Revisions | Updates | Reporting Revisions | Comments |
|---------|-----------|---------|---------------------|----------|
| **Scope** | Single work item | Single work item | All work items (batch) | Single work item |
| **Data Type** | Full snapshots | Deltas (changes only) | Full snapshots | Comment threads |
| **Field Coverage** | All fields | Only changed fields | All fields | Comment-specific |
| **Batch Support** | ❌ No | ❌ No | ✅ Yes | ❌ No |
| **Pagination** | `$top`, `$skip` | `$top`, `$skip` | `continuationToken` | `continuationToken` |
| **Old/New Values** | ❌ No | ✅ Yes | ❌ No | N/A |
| **Relations** | ✅ Yes (with `$expand`) | ✅ Yes (changes) | Limited | N/A |
| **Best For** | Complete history per item | Change tracking per item | Bulk sync/warehouse | Discussion history |
| **API Status** | GA (7.1) | GA (7.1) | GA (7.1) | Preview (7.1-preview.4) |

### When to Use Each API

#### Use **Revisions** when:
- You need complete field data for a specific work item's history
- Reconstructing exact state at each revision
- You want all fields, not just changes
- Working with a single work item

#### Use **Updates** when:
- You only care about what changed between revisions
- Tracking field modifications with old/new values
- Building change logs or audit trails
- Working with a single work item

#### Use **Reporting Revisions** when:
- Syncing work items to external system (Timely, data warehouse, etc.)
- Need to process many work items efficiently
- Building reports across entire project/organization
- Want to minimize API calls for bulk operations

#### Use **Comments** when:
- Getting discussion threads separate from field changes
- Need @mentions or reactions data
- Comments API is distinct from `System.History` field

#### Use **WIQL with ASOF** when:
- Querying work items as of specific date
- Time-based analysis and reporting
- Need to filter first, then get historical data

---

## Authentication

All APIs require OAuth2 authentication with the `vso.work` scope.

### Using with `az rest`

The `az rest` command handles authentication automatically:

```bash
az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --uri "<endpoint-url>"
```

The resource ID `499b84ac-1321-427f-aa17-267ca6975798` is the Azure DevOps resource identifier.

### Using with Personal Access Token (PAT)

```bash
curl -u :{PAT} \
  "https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}/revisions?api-version=7.1"
```

---

## Common Field Names

### System Fields

| Field | Type | Description |
|-------|------|-------------|
| `System.Id` | integer | Work item ID |
| `System.WorkItemType` | string | Type (Bug, Task, User Story, etc.) |
| `System.Title` | string | Work item title |
| `System.State` | string | Workflow state (New, Active, Resolved, etc.) |
| `System.Reason` | string | Reason for state |
| `System.CreatedBy` | IdentityRef | Creator |
| `System.CreatedDate` | date-time | Creation timestamp |
| `System.ChangedBy` | IdentityRef | Last modifier |
| `System.ChangedDate` | date-time | Last modification timestamp |
| `System.AssignedTo` | IdentityRef | Assigned user |
| `System.AreaPath` | string | Area path |
| `System.IterationPath` | string | Iteration path |
| `System.Tags` | string | Semicolon-separated tags |
| `System.History` | string | History/comments field |
| `System.TeamProject` | string | Project name |

### Common Custom Fields

| Field | Type | Description |
|-------|------|-------------|
| `Microsoft.VSTS.Common.Priority` | integer | Priority (1-4) |
| `Microsoft.VSTS.Common.Severity` | string | Severity level |
| `Microsoft.VSTS.Scheduling.StoryPoints` | float | Story points |
| `Microsoft.VSTS.Scheduling.OriginalEstimate` | float | Original estimate (hours) |
| `Microsoft.VSTS.Scheduling.RemainingWork` | float | Remaining work (hours) |
| `Microsoft.VSTS.Scheduling.CompletedWork` | float | Completed work (hours) |
| `Microsoft.VSTS.Common.Activity` | string | Activity type |

---

## Error Handling

### Common HTTP Status Codes

| Code | Meaning | Common Causes |
|------|---------|---------------|
| `200` | Success | Request completed successfully |
| `401` | Unauthorized | Invalid/missing authentication token |
| `403` | Forbidden | Insufficient permissions (`vso.work` scope needed) |
| `404` | Not Found | Work item doesn't exist or wrong project/org |
| `429` | Too Many Requests | Rate limit exceeded |

### Rate Limiting

Azure DevOps enforces rate limits. For batch operations, use:
- Reporting API for bulk work item access
- Batch endpoint for getting multiple work items: `POST /wit/workitemsbatch`
- Continuation tokens to resume interrupted queries

---

## Sources

- [Revisions - List API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/list?view=azure-devops-rest-7.1)
- [Updates - List API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/updates/list?view=azure-devops-rest-7.1)
- [Reporting Work Item Revisions - GET](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-revisions/read-reporting-revisions-get?view=azure-devops-rest-7.1)
- [Reporting Work Item Revisions - POST](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-revisions/read-reporting-revisions-post?view=azure-devops-rest-7.1)
- [Comments - Get Comments](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-7.1)
- [Comments - Get Comment](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comment?view=azure-devops-rest-7.1)
- [WIQL Syntax Reference](https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax?view=azure-devops)
- [Wiql - Query By Wiql](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1)
- [ASOF Clause in WIQL](https://medium.com/into-alm/the-good-old-asof-clause-in-wiql-queries-for-azure-devops-abf4960bca4f)

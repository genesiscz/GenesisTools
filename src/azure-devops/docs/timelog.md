# TimeLog API Reference

TimeLog is a third-party Azure DevOps extension (Publisher: TimeLog/TechsBCN) that provides time tracking and logging functionality.

**Base URL:** `https://boznet-timelogapi.azurewebsites.net/api/{orgId}`

> **Important:** All placeholders like `{orgId}`, `{projectId}`, `{workItemId}` must be replaced with actual GUIDs or IDs. Never include API keys or secrets in requests.

---

## Authentication

All requests require the following headers:

| Header | Value | Notes |
|--------|-------|-------|
| `x-functions-key` | `{functionsKey}` | Azure Functions key (auto-fetched via Extension Data API) |
| `x-timelog-usermakingchange` | `{userName}` | URL-encoded user name (e.g., `John%20Doe`) |

---

## Endpoints

### 1. Query Time Logs

Retrieve time logs matching specified filter criteria.

**Request:**
```
GET /timelog/query
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `FromDate` | string | No | Start date in format `YYYY-MM-DD` |
| `ToDate` | string | No | End date in format `YYYY-MM-DD` |
| `projectId` | string | No | Project GUID filter |
| `workitemId` | number | No | Work item ID filter |
| `userId` | string | No | Azure AD object ID filter |

**Response:**

Returns an array of `TimeLogQueryEntry` objects.

```typescript
interface TimeLogQueryEntry {
  timeLogId: string;              // Unique timelog identifier (GUID)
  comment: string | null;         // Optional user comment
  week: string;                   // ISO week format, e.g., "2026-W05"
  timeTypeId: string;             // Time type identifier (GUID)
  timeTypeDescription: string;    // Display name: "Development", "Code Review", etc.
  minutes: number;                // Duration in minutes (e.g., 120 = 2 hours)
  date: string;                   // ISO datetime, e.g., "2026-01-30T00:00:00"
  userId: string;                 // Azure AD object ID
  userName: string;               // User display name
  userEmail: string | null;       // User email address
  projectId: string;              // Project GUID
  workItemId: number;             // Azure DevOps work item ID
  createdOn: string;              // Creation timestamp (ISO datetime)
  createdBy: string;              // Creator user ID
  updatedOn: string | null;       // Last update timestamp (ISO datetime)
  updatedBy: string | null;       // Last updater user ID
  deletedOn: string | null;       // Soft deletion timestamp (ISO datetime)
  deletedBy: string | null;       // Deleter user ID
}
```

**Example:**
```bash
curl -X GET "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timelog/query?FromDate=2026-01-01&ToDate=2026-02-07&projectId={projectId}" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe"
```

**Notes:**
- At least one filter parameter is required; returns 400 "No filter specified" if none provided
- Returns ALL matching timelogs across all users/work items when filters are broad
- Also supports POST with JSON body instead of query parameters

---

### 2. Get Work Item Time Logs

Retrieve all time logs for a specific work item in a project.

**Request:**
```
GET /timelog/project/{projectId}/workitem/{workItemId}
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | Project GUID |
| `workItemId` | number | Azure DevOps work item ID |

**Response:**

Returns an array of `TimeLogEntry` objects.

```typescript
interface TimeLogEntry {
  timeLogId: string;              // Unique timelog identifier (GUID)
  comment: string;                // User comment
  week: string;                   // ISO week format, e.g., "2026-W06"
  timeTypeDescription: string;    // Display name: "Development", "Code Review", etc.
  minutes: number;                // Duration in minutes
  date: string;                   // Date in format "YYYY-MM-DD", e.g., "2026-02-04"
  userId: string;                 // Azure AD object ID
  userName: string;               // User display name
  userEmail: string;              // User email address
}
```

**Example:**
```bash
curl -X GET "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timelog/project/{projectId}/workitem/{workItemId}" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe"
```

**Notes:**
- Endpoint requires both `projectId` and `workItemId`; returns 404 if only project is specified
- Returns empty array if no timelogs exist for the work item

---

### 3. Get Project Time Types

Retrieve time types configured for a specific project.

**Request:**
```
GET /timetype/project/{projectId}
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | Project GUID |

**Response:**

Returns an array of `TimeType` objects (project-specific types, inherits org-wide types).

```typescript
interface TimeType {
  timeTypeId: string;             // Time type identifier (GUID)
  description: string;            // Display name: "Development", "Code Review", "Test", etc.
  projectId: string | null;       // Project GUID if project-specific, null if org-wide
  isDefaultForProject: boolean;   // Whether this is the default type for the project
  disabled: boolean;              // Whether this type is disabled/archived
}
```

**Example:**
```bash
curl -X GET "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timetype/project/{projectId}" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe"
```

---

### 4. Get Organization Time Types

Retrieve org-wide time types available across all projects.

**Request:**
```
GET /timetype/project
```

**Response:**

Returns an array of `TimeType` objects (org-wide types).

```typescript
interface TimeType {
  timeTypeId: string;             // Time type identifier (GUID)
  description: string;            // Display name: "Development", "Code Review", "Test", etc.
  projectId: string | null;       // null for org-wide types
  isDefaultForProject: boolean;   // Whether this is the default type
  disabled: boolean;              // Whether this type is disabled/archived
}
```

**Example:**
```bash
curl -X GET "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timetype/project" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe"
```

---

### 5. Create Time Log

Create one or more time log entries.

**Request:**
```
POST /timelogs/
```

**Request Body:**

```typescript
interface CreateTimeLogRequest {
  minutes: number;                // Duration in minutes (e.g., 120 = 2 hours)
  timeTypeDescription: string;    // Display name: "Development", "Code Review", etc.
  comment: string;                // User-provided comment/description
  date: string;                   // Date in format "YYYY-MM-DD", e.g., "2026-02-04"
  workItemId: number;             // Azure DevOps work item ID
  projectId: string;              // Project GUID
  users: Array<{
    userId: string;               // Azure AD object ID
    userName: string;             // User display name
    userEmail: string;            // User email address
  }>;
  userMakingChange: string;       // Name of user making the change (e.g., "John Doe")
}
```

**Response:**

```typescript
interface CreateTimeLogResponse {
  logsCreated: string[];          // Array of created timelog IDs (GUIDs)
}
```

**Example:**
```bash
curl -X POST "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timelogs/" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe" \
  -H "Content-Type: application/json" \
  -d '{
    "minutes": 120,
    "timeTypeDescription": "Development",
    "comment": "Fixed bug in authentication module",
    "date": "2026-02-04",
    "workItemId": 12345,
    "projectId": "{projectId}",
    "users": [
      {
        "userId": "{userId}",
        "userName": "John Doe",
        "userEmail": "john.doe@example.com"
      }
    ],
    "userMakingChange": "John Doe"
  }'
```

**Important Notes:**
- Use `timeTypeDescription` (display name like "Development"), NOT a time type UUID
- The `minutes` parameter uses minutes internally; convert hours to minutes (e.g., 2 hours = 120 minutes)
- The `users` array can contain multiple users to log time for multiple people in a single request
- Returns array of created timelog IDs on success

---

### 6. Delete Time Log

Delete a time log entry by ID.

**Request:**
```
DELETE /timelog/{timeLogId}
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `timeLogId` | string | Timelog GUID to delete |

**Response:**

Empty body on success (HTTP 200 or 204).

**Example:**
```bash
curl -X DELETE "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timelog/{timeLogId}" \
  -H "x-functions-key: {functionsKey}" \
  -H "x-timelog-usermakingchange: John%20Doe"
```

---

## Key Concepts

### Time Units

- The API uses **minutes** internally, not hours
- To log 2 hours: use `minutes: 120`
- To log 30 minutes: use `minutes: 30`

### Time Type Identification

- Use `timeTypeDescription` (display name) when creating timelogs, NOT the `timeTypeId` UUID
- Valid examples: "Development", "Code Review", "Testing", "Documentation", etc.
- Query available types with `/timetype/project/{projectId}` or `/timetype/project` endpoints

### ISO Week Format

- Week identifiers follow ISO 8601 format: `YYYY-WNN` (e.g., "2026-W05")
- Useful for grouping/aggregating timelogs by week

### Soft Deletion

- Time logs support soft deletion via `deletedOn` and `deletedBy` fields
- Deleted entries may still appear in query results with deletion metadata

---

## Error Handling

| Status | Cause | Example |
|--------|-------|---------|
| 400 | No filter specified | `/timelog/query` called without query parameters |
| 404 | Resource not found | `/timelog/project/{projectId}` without `/workitem/{id}` |
| 401 | Missing/invalid authentication | Invalid or missing `x-functions-key` header |
| 500 | Server error | Extension service unavailable |

---

## Configuration

The API key (`x-functions-key`) can be automatically fetched from Azure DevOps via the Extension Data API. Use the GenesisTools CLI:

```bash
tools azure-devops timelog configure
```

This command:
1. Prompts for organization and project selection
2. Authenticates with Azure DevOps
3. Retrieves the TimeLog extension API key from Extension Data Storage
4. Caches the key locally for future commands

---

## See Also

- [Azure DevOps REST API Reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
- [Work Item Operations](./work-item-history-api-reference.md)
- [Azure DevOps CLI Documentation](./az-rest.md)

# Azure DevOps TimeLog Automation Plan

## Summary

Add TimeLog automation functionality to the `tools azure-devops` CLI tool for managing time entries in Azure DevOps work items.

## Key Discovery: TimeLog is a Third-Party Extension

**Critical finding:** "Time Log" is NOT a native Azure DevOps feature. It's a third-party extension:

| Property | Value |
|----------|-------|
| Publisher | `TimeLog` |
| Extension | `time-logging` |
| Version | `2.0.30` |
| API Host | `boznet-timelogapi.azurewebsites.net` |
| AppId | `fa27ba12-fbde-4b28-b7e8-26b670662428` |

The extension stores time entries in its own external Azure Functions API, not in Azure DevOps work item fields.

---

## TimeLog API Endpoints (from HAR analysis)

### Base URL
```
https://boznet-timelogapi.azurewebsites.net/api/{orgId}
```

### Complete API Endpoints (Verified from HAR)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/timetype/project/{projectId}` | Get time types for specific project |
| `GET` | `/timetype/project` | Get all time types |
| `GET` | `/timelog/project/{projectId}/workitem/{workItemId}` | Get time log entries for work item |
| `POST` | `/timelogs/` | **Create time log entry** |
| `PUT` | `/timelogs/{timeLogId}` | Update time log entry (inferred) |
| `DELETE` | `/timelogs/{timeLogId}` | Delete time log entry (inferred) |

### Authentication Headers

```http
x-functions-key: <auto-fetched from Extension Data API>
x-timelog-usermakingchange: <URL-encoded username>
Content-Type: application/json
```

### Auto-Discovery of API Key

The `x-functions-key` can be automatically fetched from Azure DevOps Extension Data API:

```bash
az rest --method GET \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://extmgmt.dev.azure.com/{org}/_apis/ExtensionManagement/InstalledExtensions/TimeLog/time-logging/Data/Scopes/Default/Current/Collections/%24settings/Documents?api-version=7.1-preview"
```

Response contains `ApiKeyTextBox` with the functions key. No manual HAR capture needed!

### Data Structures (Verified from HAR)

**TimeType:**
```typescript
interface TimeType {
  timeTypeId: string;          // "3626529b-6efd-4c02-9800-861f9c0f9206"
  description: string;         // "Development", "Code Review", etc.
  projectId: string | null;    // null = org-wide
  isDefaultForProject: boolean;
  disabled: boolean;
}
```

**TimeLogEntry (GET response):**
```typescript
interface TimeLogEntry {
  timeLogId: string;           // "9a016275-6d8f-4e6f-9f8f-052f34e5b177"
  comment: string;             // "analýza, fixing"
  week: string;                // "2026-W06" (ISO week)
  timeTypeDescription: string; // "Development"
  minutes: number;             // 120 (NOT hours!)
  date: string;                // "2026-02-04" (YYYY-MM-DD)
  userId: string;              // "57c2e420-edce-6083-8a6a-a58deb1c6769"
  userName: string;            // "John Doe"
  userEmail: string;           // "user@example.com"
}
```

**CreateTimeLogRequest (POST body):**
```typescript
interface CreateTimeLogRequest {
  minutes: number;             // 120 = 2 hours
  timeTypeDescription: string; // "Development" (display name, not UUID!)
  comment: string;             // "analýza, fixing"
  date: string;                // "2026-02-04"
  workItemId: number;          // 268935
  projectId: string;           // "de25c7dd-75d8-467a-bac0-f15fac9b560d"
  users: Array<{
    userId: string;
    userName: string;
    userEmail: string;
  }>;
  userMakingChange: string;    // "John Doe"
}
```

**CreateTimeLogResponse (POST 201):**
```typescript
interface CreateTimeLogResponse {
  logsCreated: string[];       // ["9a016275-6d8f-4e6f-9f8f-052f34e5b177"]
}
```

---

## Current Azure DevOps Tool Architecture

**Files:**
- `src/azure-devops/index.ts` - Main CLI (1789 lines)
- `src/azure-devops/api.ts` - API wrapper (403 lines)
- `src/azure-devops/types.ts` - TypeScript types (269 lines)
- `src/azure-devops/utils.ts` - Utilities (1051 lines)
- `src/azure-devops/cli.utils.ts` - CLI error messages (113 lines)

**Existing Pattern:**
- Uses `az account get-access-token` for Bearer tokens
- REST API calls via `fetch()` with authorization headers
- Caching layer in `~/.genesis-tools/azure-devops/cache/`

---

## Implementation Plan

### Phase 1: TimeLog API Client

**File:** `src/azure-devops/timelog-api.ts` (new)

```typescript
// TimeLog API client for the third-party extension
class TimeLogApi {
  constructor(orgId: string, projectId: string, functionsKey: string)

  // Get all available time types
  getTimeTypes(): Promise<TimeType[]>

  // Get time types for specific project
  getProjectTimeTypes(): Promise<TimeType[]>

  // Get time log entries for a work item
  getWorkItemTimeLogs(workItemId: number): Promise<TimeLogEntry[]>

  // Create a new time log entry
  createTimeLogEntry(entry: CreateTimeLogEntry): Promise<TimeLogEntry>

  // Update an existing time log entry
  updateTimeLogEntry(entryId: string, updates: Partial<TimeLogEntry>): Promise<TimeLogEntry>

  // Delete a time log entry
  deleteTimeLogEntry(entryId: string): Promise<void>
}
```

### Phase 2: Types

**File:** `src/azure-devops/types.ts` (extend)

Add TimeLog-related interfaces.

### Phase 3: CLI Commands

**File:** `src/azure-devops/index.ts` (extend)

New commander subcommands structure:
```bash
# Main timelog command group
tools azure-devops timelog <subcommand>

# Add time log entry (quick)
tools azure-devops timelog add --workitem 268935 --hours 2 --type "Development"
tools azure-devops timelog add -w 268935 -h 2 -m 30 -t "Development" --date 2026-02-04

# Add time log entry (interactive)
tools azure-devops timelog add -i
tools azure-devops timelog add --workitem 268935 -i

# List time logs for a work item
tools azure-devops timelog list --workitem 268935

# List available time types
tools azure-devops timelog types

# Import from JSON file
tools azure-devops timelog import entries.json

# Help for timelog commands
tools azure-devops timelog --help
tools azure-devops timelog add --help
```

### Phase 4: Configuration

**Store in:** `.claude/azure/config.json`

```json
{
  "organization": "MyOrg",
  "project": "MyProject",
  "projectId": "de25c7dd-75d8-467a-bac0-f15fac9b560d",
  "orgId": "5200da26-3a3b-44fe-996c-7b6d90d88a94",
  "timelog": {
    "functionsKey": "<auto-fetched via Extension Data API>",
    "userMakingChange": "John Doe"
  }
}
```

**Auto-configuration:** Run `tools azure-devops timelog configure` to automatically fetch the API key from the TimeLog extension settings.

---

## Critical Files to Modify

1. `src/azure-devops/types.ts` - Add TimeLog types
2. `src/azure-devops/timelog-api.ts` - New file for TimeLog API
3. `src/azure-devops/index.ts` - Add CLI commands
4. `src/azure-devops/utils.ts` - Add formatters for time log output

---

## Key Implementation Notes

### Hours vs Minutes
The API uses **minutes**, not hours:
- CLI accepts both `--hours` and `--minutes` for flexibility
- Conversion: `totalMinutes = (hours * 60) + minutes`
- **Validation rules:**
  - `--hours 2 --minutes 30` → 150 minutes ✓
  - `--hours 2` → 120 minutes ✓
  - `--minutes 30` → ERROR: "Use `--hours 0 --minutes 30` to confirm you meant only 30 minutes"
  - `--hours 0 --minutes 30` → 30 minutes ✓

### TimeType by Description
The API uses **timeTypeDescription** (display name), not UUID:
- CLI: `--type "Development"`
- API: `"timeTypeDescription": "Development"`
- Fetch available types via GET `/timetype/project/{projectId}`

### User Info Required
For POST, must include full user array:
```json
"users": [{
  "userId": "57c2e420-edce-6083-8a6a-a58deb1c6769",
  "userName": "John Doe",
  "userEmail": "user@example.com"
}]
```
Get current user via: `az ad signed-in-user show` or ADO identity API.

---

## Verification Plan

1. Test GET endpoints with `curl`:
   ```bash
   curl -H "x-functions-key: ..." \
        "https://boznet-timelogapi.azurewebsites.net/api/{orgId}/timetype/project/{projectId}"
   ```
2. Test POST create with sample entry
3. Verify GET returns created entry
4. Test UPDATE/DELETE (inferred endpoints)
5. Run CLI commands end-to-end

---

## User Requirements (Confirmed)

### Entry Methods (Commander Subcommands)
- **Quick CLI entry**: `tools azure-devops timelog add -w 123 -h 2 -t Development`
- **Interactive mode**: `tools azure-devops timelog add -i`
- **Bulk import**: `tools azure-devops timelog import entries.json`
- **List logs**: `tools azure-devops timelog list -w 123`
- **List types**: `tools azure-devops timelog types`

### Prompt Library Toggle
```typescript
const USE_CLACK = 1; // Toggle between implementations

// Two implementations side-by-side:
// - @clack/prompts (primary when USE_CLACK=1)
// - @inquirer/prompts (fallback when USE_CLACK=0)
```

### Smart Help Output
When `timelog add` runs without proper data, show helpful template:
```
Usage: tools azure-devops timelog add [options]

Required (unless -i):
  -w, --workitem <id>     Work item ID to log time against
  -h, --hours <number>    Hours to log (e.g., 2)
  -t, --type <name>       Time type (see 'timelog types' for list)

Optional:
  -m, --minutes <number>  Additional minutes (requires --hours to be set)
  -d, --date <YYYY-MM-DD> Date of the entry (default: today)
  -c, --comment <text>    Description of work performed
  -i, --interactive       Interactive mode with prompts

Note: If using only minutes, specify --hours 0 --minutes <n> to confirm intent.

Available Time Types (run 'tools azure-devops timelog types'):
  - Development
  - Code Review
  - Business Analýza
  - IT Analýza
  - Test
  - Dokumentace
  - Ceremonie
  - Konfigurace
  - Release
  - UX

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
  tools azure-devops timelog add -w 268935 -i
  tools azure-devops timelog import entries.json
```

### Documentation
Update `src/azure-devops/README.md` with JSON example structure for bulk import:
```json
{
  "entries": [
    {
      "workItemId": 268935,
      "hours": 2,
      "timeType": "Development",
      "date": "2026-02-04",
      "description": "Implemented feature X"
    }
  ]
}
```

---

## Files to Create/Modify

**Prerequisites:** Refactor `index.ts` into modular commands first (see 2026-02-04-AzureDevops-RefactorCli.md)

| File | Action | Description |
|------|--------|-------------|
| `src/azure-devops/timelog-api.ts` | **Create** | TimeLog API client class |
| `src/azure-devops/types.ts` | Extend | Add TimeLog interfaces |
| `src/azure-devops/commands/timelog.ts` | **Create** | Commander subcommand: add, list, types, import |
| `src/azure-devops/timelog-prompts-clack.ts` | **Create** | @clack/prompts interactive mode |
| `src/azure-devops/timelog-prompts-inquirer.ts` | **Create** | @inquirer/prompts fallback |
| `src/azure-devops/README.md` | Update | Add JSON import structure, examples |

## Status

**READY FOR IMPLEMENTATION** - All API endpoints and data structures verified from HAR captures.

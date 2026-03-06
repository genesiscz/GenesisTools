# Clarity PPM REST API Reference

## Base URL

```
{baseUrl}/ppm/rest/v1
```

The base URL is configurable per deployment (stored in `~/.genesis-tools/clarity/config.json`).

## Authentication

All requests require two credentials:

| Credential | Transport | Format |
|------------|-----------|--------|
| `authToken` | HTTP header | `{sessionNumber}__{UUID}` |
| `sessionId` | Cookie (or can be header) | Same format as authToken |

See [authentication.md](./authentication.md) for details on extraction and session management.

## Common Headers

Every request should include:

```
Accept: application/json, text/plain, */*
Content-Type: application/json
authToken: {authToken}
Cache-Control: no-cache
```

### Special Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `x-api-force-patch` | `true` | Required for PUT operations to work correctly |
| `x-api-full-response` | `true` | Returns complete response with nested objects |
| `x-api-include-additional-messages` | `true` | Returns validation messages on submit/revert |
| `x-api-next-string` | pagination token | For paginated results |

## Endpoints

### GET `/private/timesheetApp`

Discover timesheets and navigate the time period carousel.

**Query:** `?filter=(timeperiodId = {id})`

**Response:** `TimesheetAppResponse`
- `calendar._results[]` - Days in the period with work day info
- `tpcounts` - Previous/next period counts for pagination
- `tscarousel._results[]` - Sliding window (~9 weeks) mapping `timePeriodId` to `timesheet_id`
- `timesheets._results[]` - Full timesheet data with time entries
- `resource._results[]` - Current user info (resourceId, name, email)

### GET `/private/timesheet`

Fetch a specific timesheet with all time entries.

**Query:** `?filter=(timesheetId = {id})`

**Response:** `TimesheetResponse`
- `timesheets._results[0].timeentries._results[]` - All time entry rows
- Each entry has `actuals.segmentList.segments[]` with per-day values

### PUT `/timesheets/{timesheetId}/timeEntries/{timeEntryId}`

Update hours for a specific time entry (project row).

**Body:**
```json
{
  "taskId": 1234567,
  "actuals": {
    "isFiscal": false,
    "curveType": "value",
    "total": 27000,
    "dataType": "numeric",
    "_type": "tsv",
    "start": "2026-02-09T00:00:00",
    "finish": "2026-02-15T00:00:00",
    "segmentList": {
      "total": 27000,
      "defaultValue": 0,
      "segments": [
        { "start": "2026-02-10T00:00:00", "finish": "2026-02-10T00:00:00", "value": 5400 },
        { "start": "2026-02-11T00:00:00", "finish": "2026-02-11T00:00:00", "value": 5400 }
      ]
    }
  }
}
```

**Important:** Time values are in **seconds** (3600 = 1 hour, 5400 = 1.5 hours).

### PUT `/timesheets/{timesheetId}`

Update timesheet status (submit, revert).

**Submit body:** `{ "status": "1" }`
**Revert body:** `{ "status": "2" }`

Include header: `x-api-include-additional-messages: true`

## Time Value Units

| Context | Unit | Example |
|---------|------|---------|
| Segment values | Seconds | 3600 = 1h, 5400 = 1.5h |
| `actualsTotal` | Seconds | 27000 = 7.5h |
| `workTime` / `hoursPerDay` | Hours (decimal) | 7.5 |
| `etc` (estimate to complete) | Minutes | 450 = 7.5h |

## Filter Syntax

Queries use an OData-like filter syntax:

```
?filter=(fieldName = value)
?filter=(fieldName = value) AND (otherField = value2)
```

## Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request / validation error |
| 401 | Auth token expired or invalid |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 409 | Conflict (e.g., timesheet locked by another process) |

## Timesheet Status Values

| ID | Display | Meaning |
|----|---------|---------|
| `0` | Open | Editable by resource |
| `1` | Submitted | Awaiting approval, read-only |
| `2` | Reverted | Sent back for correction, editable |
| `3` | Approved | Approved by manager |
| `4` | Posted | Finalized, cannot be changed |

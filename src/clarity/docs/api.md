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

**Query:** `?filter=(timeperiodId = {id})` — optional. Without it the server returns the window
around the current period; with it the ~9-week window re-centres on that period, which is how you
walk backwards or forwards through the year.

**Response:** `TimesheetAppResponse`
- `calendar._results[]` - Days in the period with work day info
- `tpcounts` - Previous/next period counts for pagination
- `tscarousel._results[]` - Sliding window (~9 weeks) of periods
- `timesheets._results[]` - Full timesheet data with time entries
- `resource._results[]` - Current user info (resourceId, name, email)

**Carousel entry shape.** The timesheet id is nested, not a sibling of `id`:

```json
{
  "id": 400004,
  "start_date": "2026-08-24T00:00:00",
  "finish_date": "2026-08-31T00:00:00",
  "has_entries": "true",
  "is_active": true,
  "selected_id": 400004,
  "resourceId": 900001,
  "tpTimesheet": {
    "_results": [
      {
        "timesheet_id": 555004,
        "total": "0,00",
        "prstatus": { "_results": [{ "displayValue": "Otevřeno", "id": "0" }] }
      }
    ]
  }
}
```

Some responses return `timesheet_id`, `total` and `prstatus` flat on the entry instead. Parse both
shapes — `parseCarouselEntry` in `src/clarity/lib/timesheet-weeks.ts` does.

**`finish_date` is exclusive.** Adjacent periods share a boundary date: one ends `2026-08-24` while
the next starts `2026-08-24`, and the timesheet for the second reports `timePeriodStart 2026-08-24`
/ `timePeriodFinish 2026-08-30`. Match a date with `start <= date < finish`, which is what
`findWeekForDate` does. An inclusive comparison assigns boundary days to the wrong week.

**No timesheet id needed to start.** This endpoint is the discovery entry point: call it with no
filter, read `tpTimesheet._results[0].timesheet_id` off the carousel, and you have a valid
timesheet id without any stored mapping.

### GET `/private/timesheet`

Fetch a specific timesheet with all time entries.

**Query:** `?filter=(timesheetId = {id})`

**Response:** `TimesheetResponse`
- `timesheets._results[0].timeentries._results[]` - All time entry rows
- Each entry has `actuals.segmentList.segments[]` with per-day values

### GET `/timesheets/{timesheetId}/timeEntries`

List the task rows of a timesheet.

**🛑 The collection returns `_internalId` and nothing else**, whatever `x-api-full-response` says:

```json
{"_totalCount":8,"_results":[{"_internalId":11110541,"_parent":"…","_self":"…"}]}
```

Learning a row's `taskId` therefore costs one `GET /timesheets/{id}/timeEntries/{_internalId}` per
row. Use `GET /private/timesheet?filter=(timesheetId = N)` for reading instead: it returns the full
rows in a single call. This collection is only worth using for writing.

### POST `/timesheets/{timesheetId}/timeEntries`

Add a task row to a timesheet.

**Body:** `{ "taskId": 8902005 }`

`taskId` is the only field the caller supplies. The server fills `assignmentId`, `resourceId`,
`role`, `investmentId` and `phaseId` from the resource's assignment.

An empty body answers `400` with
`TMA-1011: Chybějící nebo nulová hodnota požadovaného atributu "taskId"`, error code
`timeadmin.timeentry.api.NULL_TASK`. That is the cheap way to confirm the verb exists without
creating anything.

Posting a `taskId` the timesheet already carries is NOT verified; read the collection first and post
only the missing ids, which is what `addTaskRows` does.

Observed 2026-09-04: a successful POST answers with a JSON body, not an empty one. An expired
session answers **200 with an HTML login page**, so neither verb may trust the status code alone.

### DELETE `/timesheets/{timesheetId}/timeEntries/{timeEntryId}`

Remove a task row. Answers `200` with an empty body, so it must not be parsed as JSON.

An unknown id answers `404` with `API-1004 : Neplatný identifikátor zdroje {id}`, error code
`api.invalidResourceId`. Verified 2026-09-04.

**🛑 Clarity asks for no confirmation and deletes a row that carries actuals along with its hours.**
`removeTaskRows` refuses any row whose `totalActuals` is above zero, absent, `null` or `NaN`.
Only a real, finite zero proves a row is empty.

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

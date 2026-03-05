# Clarity Timesheet Workflow

## Timesheet Lifecycle

```
Open (0) ──submit──> Submitted (1) ──approve──> Approved (3) ──post──> Posted (4)
   ^                     │
   └───── revert (2) ────┘
```

- **Open**: Resource can edit hours
- **Submitted**: Awaiting manager approval, read-only for resource
- **Reverted**: Manager sent back for corrections, resource can edit
- **Approved**: Manager approved, pending posting
- **Posted**: Finalized into the financial system, immutable

## Discovering Timesheets

### The Carousel Pattern

Clarity doesn't expose a simple "get timesheet by date" endpoint. Instead, you navigate via the **TimesheetApp carousel**:

1. Start with a known `timePeriodId`
2. Call `GET /private/timesheetApp?filter=(timeperiodId = {id})`
3. The response includes `tscarousel._results[]` — a sliding window of ~9 time periods
4. Each carousel entry maps: `id` (timePeriodId) -> `timesheet_id` (timesheetId)
5. Use the `timesheet_id` to fetch full timesheet data

### Finding a Date's Timesheet

```
Target date: 2026-02-12
  -> Find carousel entry where start_date <= 2026-02-12 <= finish_date
  -> Use that entry's timesheet_id
```

### Navigating Beyond the Carousel Window

If the target date is outside the carousel window, use `tpcounts.prev_count` / `tpcounts.next_count` to determine if more periods exist, then navigate by adjusting the timePeriodId.

## Time Entry Structure

Each timesheet contains multiple **time entries** (rows), one per project/task assignment:

```
Timesheet (week Feb 9-15)
├── TimeEntry: Project Alpha / Task A  [Mon: 4h, Tue: 4h, ...]
├── TimeEntry: Project Beta / Task B   [Mon: 3.5h, Wed: 3.5h, ...]
└── TimeEntry: Internal / Ceremonies   [Mon: 0.5h, Tue: 0.5h, ...]
```

### Segment Array Format

Hours are stored as a segment array within each time entry's `actuals`:

```json
{
  "actuals": {
    "segmentList": {
      "segments": [
        { "start": "2026-02-10T00:00:00", "finish": "2026-02-10T00:00:00", "value": 14400 },
        { "start": "2026-02-11T00:00:00", "finish": "2026-02-11T00:00:00", "value": 14400 }
      ]
    }
  }
}
```

- Each segment = one day
- `start` and `finish` are the same (single day)
- `value` is in **seconds** (14400 = 4 hours)
- Days with 0 hours can be omitted from the array

## Updating Hours

### PUT Request Structure

To update a time entry's hours:

```
PUT /timesheets/{timesheetId}/timeEntries/{timeEntryId}
```

The body must include:
- `taskId`: The Clarity internal task ID (from the time entry's `taskId` field)
- `actuals`: Complete `TimeSeriesValue` object with updated segments

### Rules

1. The timesheet must be in **Open** (0) or **Reverted** (2) status
2. You must send the **full segment array** for the week (not a partial update)
3. The `start`/`finish` in the outer `actuals` should span the full time period
4. `total` in both `actuals` and `segmentList` should equal the sum of segment values

## Submit / Revert Flow

### Submitting a Timesheet

```
PUT /timesheets/{timesheetId}
Body: { "status": "1" }
Header: x-api-include-additional-messages: true
```

The response may include validation messages (e.g., "hours don't meet minimum").

### Reverting a Submitted Timesheet

```
PUT /timesheets/{timesheetId}
Body: { "status": "2" }
Header: x-api-include-additional-messages: true
```

Only works if the timesheet is in Submitted (1) status and hasn't been approved yet.

## Mapping ADO TimeLog to Clarity

Azure DevOps TimeLog tracks time per work item (fine-grained tasks). Clarity tracks time per project/phase (coarse-grained). The mapping flow:

1. **ADO side**: Export time entries grouped by work item for a date range
2. **Mapping**: Each ADO work item maps to a Clarity task (many-to-one)
3. **Aggregation**: Sum ADO minutes per day, per Clarity task
4. **Conversion**: ADO minutes * 60 = Clarity seconds
5. **Fill**: Update each Clarity time entry's segment array with the aggregated values

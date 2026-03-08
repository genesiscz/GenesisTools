# Clarity Timelog Integration - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool (`tools clarity`) that bridges Azure DevOps TimeLog entries to CA PPM Clarity timesheets, with configurable API, interactive mapping, and automated fill.

**Architecture:** Clarity API client in `src/utils/clarity/` (reusable), CLI tool in `src/clarity/` with Commander subcommands, cURL parser in `src/utils/curl.ts`, ADO timelog export in `src/azure-devops/lib/timelog/export.ts`. Config stored in `~/.genesis-tools/clarity/config.json`.

**Tech Stack:** TypeScript, Bun, Commander, @clack/prompts, Zod, existing Storage utility

---

## Phase 1: Foundation — Utilities & API Client

### Task 1: cURL Parser Utility (`src/utils/curl.ts`)

**Files:**
- Create: `src/utils/curl.ts`

**Step 1: Implement cURL parser**

The parser interprets a pasted cURL command string, extracting URL, method, headers, cookies, and body. It handles multi-line commands with `\` continuations, quoted strings, and both `-b`/`--cookie` and `-H 'Cookie: ...'` patterns.

```typescript
// src/utils/curl.ts
export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: string | null;
}

export function parseCurl(curlString: string): ParsedCurl {
  // 1. Normalize: join continuation lines, strip leading 'curl'
  // 2. Tokenize respecting single/double quotes
  // 3. Parse tokens: -X/--request → method, -H/--header → headers,
  //    -b/--cookie → cookies, --data-raw/--data/-d → body, positional → url
  // 4. Parse cookie string (semicolon-separated key=value pairs)
  // 5. Also check for Cookie header in -H flags
}
```

Key edge cases:
- Multi-line with `\` continuations
- Single and double quoted values
- `-b 'key1=val1; key2=val2'` cookie string parsing
- `--data-raw '{json}'` body extraction
- URL as first positional arg or with `--url`
- Default method: GET (POST if body present)

**Step 2: Commit**

```bash
git add src/utils/curl.ts
git commit -m "feat(utils): add cURL command parser for cookie/header extraction"
```

### Task 2: Clarity Response Types (`src/utils/clarity/types/`)

**Files:**
- Create: `src/utils/clarity/types/response.types.ts`
- Create: `src/utils/clarity/types/request.types.ts`
- Create: `src/utils/clarity/types/index.ts`

**Step 1: Define response types from the live API response**

Based on the actual API response from `/ppm/rest/v1/private/timesheet`:

```typescript
// src/utils/clarity/types/response.types.ts

// -- Top-level response --
export interface TimesheetResponse {
  calendar: CalendarSection;
  timesheets: TimesheetsSection;
  resource: ResourceSection;
  resourcecalendar: ResourceCalendarSection;
  _self: string;
  _metadata: { virtualResource: string };
}

// -- Calendar --
export interface CalendarSection {
  _self: string;
  _results: CalendarDay[];
}

export interface CalendarDay {
  date: string;        // ISO "2026-02-09T00:00:00"
  shortForm: string;   // "9.2"
  dayOfEmployment: string;
  _self: string;
  workDay: string;     // "true" | "false"
  day: string;         // "Po" | "Út" | "St" | "Čt" | "Pá" | "So" | "Ne"
  workTime: number;    // 7.5 or 0
  hoursPerDay: number; // 7.5
}

// -- Timesheets --
export interface TimesheetsSection {
  _self: string;
  _results: TimesheetRecord[];
}

export interface TimesheetRecord {
  _internalId: number;  // timesheetId (e.g. 8524081)
  resourceId: number;
  isActive: boolean;
  actualsTotal: number;
  timePeriodStart: string;   // ISO
  timePeriodFinish: string;  // ISO
  timePeriodId: number;
  timePeriodOffset: number;
  version: number;
  status: LookupField;       // id: "0"=Open, "1"=Submitted, "2"=Reverted
  resourceName: string;
  uniqueName: string;
  lastUpdatedDate: string;
  lastUpdatedBy: string;
  numberOfEntries: number;
  hasNotes: boolean;
  hasAssignments: boolean;
  timePeriodIsOpen: boolean;
  employmentType: LookupField;
  resourceType: LookupField;
  _authorization: TimesheetAuthorization;
  timeentries: TimeEntriesSection;
  timesheetNotes: { _self: string };
  timeEntries: { _self: string };  // camelCase variant
  // Optional fields
  definedTeamId: number | null;
  isBeingAdjusted: boolean;
  approvedBy: string | null;
  vendor: string | null;
  submittedBy: string | null;
  failedrules: string | null;
  daysOverdue: number | null;
  postedTime: string | null;
  adjustedTimesheetId: number | null;
  isAdjustment: boolean;
  resourceObsFilter: string | null;
  prmodBY: LookupField;
  resourceManager: string;
  resourceManagerName: LookupField;
  attestationMessage: string;
  timePeriod: LookupField;
}

export interface TimesheetAuthorization {
  view: boolean;
  edit: boolean;
  approve: boolean;
  adjust: boolean;
  delete: boolean;
  return: boolean;
}

// -- Time Entries --
export interface TimeEntriesSection {
  _self: string;
  _results: TimeEntryRecord[];
}

export interface TimeEntryRecord {
  _internalId: number;     // timeEntryId (e.g. 10311311)
  resourceId: number;
  taskId: number;          // internal task ID (e.g. 8366010)
  taskCode: string;        // e.g. "00070705"
  taskName: string;        // e.g. "262351_Release_Externí_Capex"
  taskFullName: string;    // e.g. "Fixní část/262351_Release_Externí_Capex"
  taskShortName: string | null;
  taskStartDate: string;
  taskFinishDate: string;
  phaseName: string;       // e.g. "Fixní část"
  phaseId: string;
  parentTaskName: string;
  parentTaskId: string;
  investmentId: number;
  investmentName: string;  // e.g. "Domain Project X"
  investmentCode: string;  // e.g. "P000000"
  investmentType: string;  // e.g. "project"
  investmentAlias: string;
  invBlueprintId: string;
  isInvestmentActive: boolean;
  isTeamInvestment: number;
  assignmentId: number;
  role: LookupField;
  etc: number;             // Estimate to complete (minutes)
  etcOriginal: number | null;
  totalActuals: number;    // Total actuals (seconds)
  postedActuals: number;
  baseline: number;
  actuals: TimeSeriesValue;
  _authorization: { view: boolean; edit: boolean; delete: boolean };
  _self: string;
  resourceFirstName: string;
  resourceLastName: string;
  lastUpdatedBy: string;
  lastUpdatedDate: string;
  numberOfNotes: number;
  timeEntryNotes: { _self: string };
  inputTypeCode: string | null;
  chargeCode: string | null;
  userValue1: string | null;
  userValue2: string | null;
}

// -- Time Series Value (used in actuals & PUT body) --
export interface TimeSeriesValue {
  isFiscal: boolean;
  curveType: string;      // "value"
  total: number;
  dataType: string;       // "numeric"
  _type: string;          // "tsv"
  start: string;          // ISO
  finish: string;         // ISO
  segmentList: SegmentList;
}

export interface SegmentList {
  total: number;
  defaultValue: number;
  segments: TimeSegment[];
}

export interface TimeSegment {
  start: string;   // ISO "2026-02-09T00:00:00"
  finish: string;  // same as start (single day)
  value: number;   // seconds! 3600 = 1h, 5400 = 1.5h
}

// -- Shared types --
export interface LookupField {
  displayValue: string;
  _type: string;   // "lookup"
  id: string;
}

// -- Resource --
export interface ResourceSection {
  _self: string;
  _results: ResourceRecord[];
}

export interface ResourceRecord {
  id: number;           // resourceId
  user_id: number;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  roleName: string;
  is_active: string;
  prtrackmode: string;
  prisopen: boolean;
  canApprove: boolean;
  canEnterTimeForOthers: boolean;
  definedTeamId: number;
  teamMemberCount: number;
  resource_type: { _self: string; _results: LookupField[] };
  _self: string;
}

export interface ResourceCalendarSection {
  _self: string;
  _results: CalendarDay[];
}

// -- TimesheetApp response (for discovery) --
export interface TimesheetAppResponse {
  calendar: CalendarSection;
  tpcounts: TimePeriodCounts;
  resource: ResourceSection;
  resourcecalendar: ResourceCalendarSection;
  options: Record<string, unknown>;
  tscarousel: TimesheetCarousel;
  timesheets: TimesheetsSection;
  _self: string;
  _metadata: { virtualResource: string };
}

export interface TimePeriodCounts {
  resourceId: number;
  prev_count: number;
  next_count: number;
}

export interface TimesheetCarousel {
  _self: string;
  _results: CarouselEntry[];
}

export interface CarouselEntry {
  id: number;              // timePeriodId
  timesheet_id: number;    // THE timesheetId we need
  start_date: string;      // ISO
  finish_date: string;     // ISO
  total: number;           // total hours logged
  prstatus: LookupField;  // status
  _self: string;
}
```

```typescript
// src/utils/clarity/types/request.types.ts

export interface UpdateTimeEntryRequest {
  taskId: number;
  actuals: TimeSeriesValue;  // from response.types.ts
}

export interface UpdateTimesheetStatusRequest {
  status: "0" | "1" | "2";  // 0=Open, 1=Submit, 2=Revert
}
```

```typescript
// src/utils/clarity/types/index.ts
export * from "./response.types.js";
export * from "./request.types.js";
```

**Step 2: Commit**

```bash
git add src/utils/clarity/
git commit -m "feat(clarity): add Clarity API response/request type definitions"
```

### Task 3: Clarity API Client (`src/utils/clarity/api.ts`)

**Files:**
- Create: `src/utils/clarity/api.ts`
- Create: `src/utils/clarity/index.ts`

**Step 1: Implement the API client**

```typescript
// src/utils/clarity/api.ts
import type {
  TimesheetResponse,
  TimesheetAppResponse,
  UpdateTimeEntryRequest,
  UpdateTimesheetStatusRequest,
  CarouselEntry,
} from "./types/index.js";

export interface ClarityApiConfig {
  baseUrl: string;      // e.g. "https://clarity.example.com"
  authToken: string;    // from SSO cookie
  sessionId: string;    // from cookie
}

export class ClarityApi {
  constructor(private config: ClarityApiConfig) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}/ppm/rest/v1${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "authToken": this.config.authToken,
        "Cache-Control": "no-cache",
        "x-api-force-patch": "true",
        "x-api-full-response": "true",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Clarity API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /** Fetch a full timesheet with all time entries */
  async getTimesheet(timesheetId: number): Promise<TimesheetResponse> {
    return this.request<TimesheetResponse>(
      `/private/timesheet?filter=(timesheetId = ${timesheetId})`
    );
  }

  /** Discover timesheets via timesheetApp (returns carousel with timesheet_id mapping) */
  async getTimesheetApp(timePeriodId: number): Promise<TimesheetAppResponse> {
    return this.request<TimesheetAppResponse>(
      `/private/timesheetApp?filter=(timeperiodId = ${timePeriodId})`
    );
  }

  /** Find timesheetId for a specific date by navigating the carousel */
  async findTimesheetForDate(knownTimePeriodId: number, targetDate: Date): Promise<CarouselEntry | null> {
    const app = await this.getTimesheetApp(knownTimePeriodId);
    const target = targetDate.toISOString().split("T")[0];

    for (const entry of app.tscarousel._results) {
      const start = entry.start_date.split("T")[0];
      const finish = entry.finish_date.split("T")[0];
      if (target >= start && target <= finish) {
        return entry;
      }
    }
    return null;
  }

  /** Update time entry hours (segments in seconds: 3600 = 1h) */
  async updateTimeEntry(
    timesheetId: number,
    timeEntryId: number,
    body: UpdateTimeEntryRequest
  ): Promise<unknown> {
    return this.request(`/timesheets/${timesheetId}/timeEntries/${timeEntryId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  /** Submit timesheet (status=1) */
  async submitTimesheet(timesheetId: number): Promise<unknown> {
    const body: UpdateTimesheetStatusRequest = { status: "1" };
    return this.request(`/timesheets/${timesheetId}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "x-api-include-additional-messages": "true" },
    });
  }

  /** Revert timesheet to allow edits (status=2) */
  async revertTimesheet(timesheetId: number): Promise<unknown> {
    const body: UpdateTimesheetStatusRequest = { status: "2" };
    return this.request(`/timesheets/${timesheetId}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "x-api-include-additional-messages": "true" },
    });
  }
}
```

```typescript
// src/utils/clarity/index.ts
export { ClarityApi } from "./api.js";
export type { ClarityApiConfig } from "./api.js";
export * from "./types/index.js";
```

**Step 2: Commit**

```bash
git add src/utils/clarity/
git commit -m "feat(clarity): add Clarity PPM API client with timesheet CRUD operations"
```

### Task 4: Clarity Config & Storage (`src/clarity/config.ts`)

**Files:**
- Create: `src/clarity/config.ts`

**Step 1: Define config schema and storage**

```typescript
// src/clarity/config.ts
import { Storage } from "../utils/storage/storage.js";
import { z } from "zod";

const MappingSchema = z.object({
  clarityTaskId: z.number(),
  clarityTaskName: z.string(),
  clarityTaskCode: z.string(),
  clarityInvestmentName: z.string(),
  clarityInvestmentCode: z.string(),
  clarityTimesheetId: z.number().optional(), // cached, may change per week
  clarityTimeEntryId: z.number().optional(), // cached, may change per week
  adoWorkItemId: z.number(),
  adoWorkItemTitle: z.string(),
  adoWorkItemType: z.string().optional(),
});

const ClarityConfigSchema = z.object({
  baseUrl: z.string().url(),
  authToken: z.string(),
  sessionId: z.string(),
  resourceId: z.number().optional(),
  uniqueName: z.string().optional(),
  mappings: z.array(MappingSchema).default([]),
});

export type ClarityMapping = z.infer<typeof MappingSchema>;
export type ClarityConfig = z.infer<typeof ClarityConfigSchema>;

const storage = new Storage("clarity");

export function getConfig(): ClarityConfig | null {
  const raw = storage.readConfig<ClarityConfig>("config");
  if (!raw) return null;
  const result = ClarityConfigSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function saveConfig(config: ClarityConfig): void {
  storage.writeConfig("config", config);
}

export function requireConfig(): ClarityConfig {
  const config = getConfig();
  if (!config) {
    throw new Error(
      "Clarity not configured. Run: tools clarity configure"
    );
  }
  return config;
}

export function getMappingForWorkItem(workItemId: number): ClarityMapping | undefined {
  const config = getConfig();
  return config?.mappings.find(m => m.adoWorkItemId === workItemId);
}

export function getMappingForClarityTask(taskName: string): ClarityMapping | undefined {
  const config = getConfig();
  return config?.mappings.find(m => m.clarityTaskName === taskName);
}
```

**Step 2: Commit**

```bash
git add src/clarity/config.ts
git commit -m "feat(clarity): add config schema with Zod validation and mapping storage"
```

---

## Phase 2: CLI Tool — `tools clarity`

### Task 5: Clarity CLI Entry Point (`src/clarity/index.ts`)

**Files:**
- Create: `src/clarity/index.ts`

**Step 1: Set up Commander program with subcommands**

```typescript
// src/clarity/index.ts
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerTimesheetCommand } from "./commands/timesheet.js";
import { registerFillCommand } from "./commands/fill.js";
import { registerLinkCommand } from "./commands/link-workitems.js";

const program = new Command()
  .name("clarity")
  .description("CA PPM Clarity timesheet management & ADO integration")
  .version("1.0.0");

registerConfigureCommand(program);
registerTimesheetCommand(program);
registerFillCommand(program);
registerLinkCommand(program);

program.parse();
```

**Step 2: Commit**

```bash
git add src/clarity/index.ts
git commit -m "feat(clarity): add CLI entry point with Commander subcommands"
```

### Task 6: Configure Command (`src/clarity/commands/configure.ts`)

**Files:**
- Create: `src/clarity/commands/configure.ts`

**Step 1: Implement interactive configuration**

Uses @clack/prompts for:
1. **Setup auth** — Prompts user to paste a cURL from browser DevTools. Uses `parseCurl()` to extract `authToken` header and `sessionId` cookie. Multi-line input support. Guide text explains how to copy cURL from Chrome Network tab.
2. **Set base URL** — Extracted from the pasted cURL URL automatically.
3. **Test connection** — Calls `getTimesheetApp()` with a known period to verify auth works.
4. **Manage mappings** — Sub-menu with:
   - List current mappings (table format)
   - Add new mapping (interactive flow — see Task 8)
   - Edit mapping
   - Remove mapping

The `configure` command should have subcommands:
- `tools clarity configure` — interactive setup (auth + test connection)
- `tools clarity configure mappings` — manage ADO↔Clarity mappings
- `tools clarity configure show` — show current config (redacted auth)

**Step 2: Commit**

```bash
git add src/clarity/commands/configure.ts
git commit -m "feat(clarity): add interactive configure command with cURL auth extraction"
```

### Task 7: Timesheet Command (`src/clarity/commands/timesheet.ts`)

**Files:**
- Create: `src/clarity/commands/timesheet.ts`

**Step 1: Implement timesheet listing and viewing**

- `tools clarity timesheet list --month 2 --year 2026` — Shows all weeks in that month with timesheetId, status, total hours. Uses `getTimesheetApp()` + carousel navigation.
- `tools clarity timesheet show <timesheetId>` — Shows full timesheet with all time entries, hours per day.
- `tools clarity timesheet submit <timesheetId>` — Submit (with confirmation prompt)
- `tools clarity timesheet revert <timesheetId>` — Revert (with confirmation prompt)

Output formats: `--format table` (default), `--format json`

**Step 2: Commit**

```bash
git add src/clarity/commands/timesheet.ts
git commit -m "feat(clarity): add timesheet list/show/submit/revert commands"
```

### Task 8: Link Workitems Command (`src/clarity/commands/link-workitems.ts`)

**Files:**
- Create: `src/clarity/commands/link-workitems.ts`

**Step 1: Interactive mapping flow**

`tools clarity link-workitems` (interactive mode):
1. Ask month/year → find weeks → load timesheets
2. Show Clarity projects from timesheet entries
3. User picks a Clarity project
4. Show ADO work items (query user's assigned items via existing ADO tooling)
5. Fuzzy search/filter for matching — use `src/utils/string.ts` for fuzzy matching
6. Show suggested matches (keyword-based) for convenience
7. User picks ADO work item → saves mapping to config

`tools clarity link-workitems --list` (non-interactive):
- Returns JSON with: ADO workitems, Clarity projects, existing mappings, suggested matches

`tools clarity link-workitems --azure-devops-workitem <id> --clarity-project <taskName>`:
- Creates mapping directly (for programmatic use by AI agent)

`tools clarity link-workitems --unlink <adoWorkItemId>`:
- Removes mapping

**Step 2: Commit**

```bash
git add src/clarity/commands/link-workitems.ts
git commit -m "feat(clarity): add interactive and programmatic workitem-to-clarity linking"
```

### Task 9: Fill Command (`src/clarity/commands/fill.ts`)

**Files:**
- Create: `src/clarity/commands/fill.ts`

**Step 1: Implement the fill workflow**

`tools clarity fill --month 2 --year 2026` (always dry-run first):

1. Export ADO timelog for month (using `exportMonth()` from Phase 3)
2. Group ADO entries by mapped Clarity project
3. For unmapped entries: warn and skip (suggest running `link-workitems`)
4. Convert ADO minutes → Clarity seconds (× 60)
5. For each week in the month:
   a. Find timesheetId via carousel
   b. Find matching timeEntryId for each Clarity project
   c. Build segment arrays with per-day values
6. Show preview table:

```
Week: Feb 9-15, 2026 (Timesheet: 8524081)
┌──────────────────────────────────┬────────┬────────┬────────┬────────┬────────┬───────┐
│ Clarity Project                  │ Mon    │ Tue    │ Wed    │ Thu    │ Fri    │ Total │
├──────────────────────────────────┼────────┼────────┼────────┼────────┼────────┼───────┤
│ 262351_Release_Externí_Capex     │ 3.33h  │ 3.33h  │ 3.33h  │ 3.33h  │ 3.33h  │ 16.65 │
│ 262042_Ceremonie_Externí_Capex   │ 0.50h  │ 0.50h  │ 0.50h  │ 0.50h  │ 0.50h  │  2.50 │
└──────────────────────────────────┴────────┴────────┴────────┴────────┴────────┴───────┘
```

7. Ask confirmation via AskUserQuestion (or `--confirm` flag for non-interactive)
8. On confirm: execute all `updateTimeEntry` calls
9. Report results

`tools clarity fill --month 2 --year 2026 --dry-run` — explicit dry run (default behavior)
`tools clarity fill --month 2 --year 2026 --confirm` — actually execute the fill

**Step 2: Commit**

```bash
git add src/clarity/commands/fill.ts
git commit -m "feat(clarity): add fill command with dry-run preview and confirm execution"
```

---

## Phase 3: ADO Timelog Export

### Task 10: Export Library (`src/azure-devops/lib/timelog/export.ts`)

**Files:**
- Create: `src/azure-devops/lib/timelog/export.ts`

**Step 1: Implement reusable export function**

```typescript
// src/azure-devops/lib/timelog/export.ts
import { TimeLogApi } from "../../timelog-api.js";
import type { TimeLogEntry } from "../../types.js";

export interface ExportedEntry extends TimeLogEntry {
  workItemTitle: string;
  workItemType: string;
  teamProject: string;
}

export interface MonthExport {
  month: number;
  year: number;
  fromDate: string;
  toDate: string;
  entries: ExportedEntry[];
  summary: {
    totalMinutes: number;
    totalHours: number;
    entriesByProject: Record<string, { minutes: number; count: number }>;
    entriesByWorkItem: Record<number, { minutes: number; title: string; count: number }>;
    entriesByDay: Record<string, number>;  // date → minutes
  };
}

export async function exportMonth(
  api: TimeLogApi,
  month: number,
  year: number,
  userId: string,
  options?: { enrichWorkItems?: boolean }
): Promise<MonthExport> {
  // 1. Query timelog entries for full month
  // 2. Optionally enrich with work item titles via batch fetch
  // 3. Build summary aggregations
  // 4. Return structured export
}
```

The function:
- Calls `api.queryTimeLogs({ fromDate, toDate, userId })` (existing API)
- Optionally batch-fetches work item titles for all unique workItemIds
- Builds summary with aggregations by project, workItem, and day
- Returns structured `MonthExport`

**Step 2: Commit**

```bash
git add src/azure-devops/lib/timelog/export.ts
git commit -m "feat(azure-devops): add reusable timelog export-month library function"
```

### Task 11: Export Month Command (`src/azure-devops/commands/timelog/export-month.ts`)

**Files:**
- Create: `src/azure-devops/commands/timelog/export-month.ts`
- Modify: `src/azure-devops/commands/timelog/index.ts` (register new command)

**Step 1: CLI command wrapping the export library**

```bash
# Usage:
tools azure-devops timelog export-month --month 2 --year 2026 --format json
tools azure-devops timelog export-month --month 2 --year 2026 --format table
tools azure-devops timelog export-month --month 2 --year 2026 --format json --output export.json
```

Options:
- `--month <n>` — month number (1-12)
- `--year <n>` — year (default: current)
- `--format <table|json>` — output format
- `--output <file>` — save to file
- `--user <name>` — override user (default: @me from config)
- `--enrich` — include work item titles (slower, extra API calls)

Table format shows:
```
February 2026 - Time Log Export
Total: 142.5h across 85 entries

By Work Item:
┌────────┬──────────────────────────────────────┬────────┬─────────┐
│ ID     │ Title                                │ Hours  │ Entries │
├────────┼──────────────────────────────────────┼────────┼─────────┤
│ 268935 │ Upgrade projektů na React 19         │  45.0  │    12   │
│ 262351 │ Release                              │  12.0  │     8   │
└────────┴──────────────────────────────────────┴────────┴─────────┘
```

**Step 2: Register in timelog command index**

Add import and registration in the existing timelog commands index.

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog/export-month.ts src/azure-devops/commands/timelog/index.ts
git commit -m "feat(azure-devops): add timelog export-month CLI command"
```

---

## Phase 4: Clarity API Documentation

### Task 12: API Documentation (`src/clarity/docs/`)

**Files:**
- Create: `src/clarity/docs/api.md`
- Create: `src/clarity/docs/authentication.md`
- Create: `src/clarity/docs/timesheet-workflow.md`

**Step 1: Write comprehensive API docs**

`api.md` — Full endpoint reference:
- Base URL pattern: `{baseUrl}/ppm/rest/v1/`
- All endpoints with request/response shapes
- Query parameter syntax (ODATA-like filters)
- Time values in seconds (3600 = 1h)
- The `x-api-force-patch`, `x-api-full-response`, `x-api-next-string` headers
- Status codes and error handling

`authentication.md` — Auth guide:
- Cookie-based auth (sessionId + authToken from SSO)
- How to extract from browser DevTools
- Session expiry behavior
- The AUTH_TOKEN cookie vs authToken header

`timesheet-workflow.md` — Workflow docs:
- Timesheet lifecycle: Open → Submitted → Posted
- TimesheetApp carousel for discovering timesheetIds
- timePeriodId → timesheetId mapping
- Segment array format for updating hours
- Submit/revert flow

**Step 2: Commit**

```bash
git add src/clarity/docs/
git commit -m "docs(clarity): add comprehensive API, auth, and workflow documentation"
```

---

## Phase 5: Skill Update

### Task 13: Update Timelog Skill (`plugins/genesis-tools/skills/timelog/SKILL.md`)

**Files:**
- Modify: `plugins/genesis-tools/skills/timelog/SKILL.md`

**Step 1: Add Clarity section to the skill**

Add a new major section "## Clarity (CA PPM) Integration" covering:

1. What Clarity is and how it relates to ADO TimeLog
2. Configuration workflow: `tools clarity configure`
3. Mapping workflow: `tools clarity link-workitems`
4. The granularity difference: ADO Tasks → Clarity Features/Projects
5. Special project mappings (Ceremonie, Release, Provoz, Incidenty)
6. Export + fill workflow:
   ```bash
   # 1. Export from ADO
   tools azure-devops timelog export-month --month 2 --year 2026 --format json
   # 2. Preview fill into Clarity
   tools clarity fill --month 2 --year 2026 --dry-run
   # 3. Execute fill
   tools clarity fill --month 2 --year 2026 --confirm
   ```
7. Timesheet management: list, show, submit, revert
8. The `clarity-` prefix for prepare-import JSON format

Also update trigger description to include "clarity", "fill clarity", "sync to clarity", "ppm", "export timelog".

**Step 2: Commit**

```bash
git add plugins/genesis-tools/skills/timelog/SKILL.md
git commit -m "docs(skill): update timelog skill with Clarity integration workflows"
```

---

## Phase 6: Verification

### Task 14: End-to-End Test — Fill Week Feb 9-15

**Step 1: Verify auth**
```bash
tools clarity configure  # paste cURL, verify connection
```

**Step 2: Check existing timesheet**
```bash
tools clarity timesheet show 8524081 --format table
```

**Step 3: Export ADO data for February**
```bash
tools azure-devops timelog export-month --month 2 --year 2026 --format table
```

**Step 4: Create a test mapping**
```bash
tools clarity link-workitems \
  --azure-devops-workitem 262351 \
  --clarity-project "262351_Release_Externí_Capex"
```

**Step 5: Dry-run fill for the week (3.33h per day)**
```bash
tools clarity fill --month 2 --year 2026 --dry-run
```

Verify the preview shows 3.33h for every workday.

**Step 6: Ask user to verify**

Use AskUserQuestion to confirm the dry-run output looks correct before proceeding.

**Step 7: Execute fill (with user confirmation)**
```bash
tools clarity fill --month 2 --year 2026 --confirm
```

**Step 8: Verify in Clarity UI**

Ask user to check Clarity UI to confirm hours appear correctly.

---

## Sensitive Data Notes

**Note:** All auth tokens, API keys, user IDs, resource IDs, and org-specific URLs are stored in config only. Never hardcode credentials.

# Azure DevOps TimeLog Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement time logging functionality for Azure DevOps work items using the third-party TimeLog extension API.

**Architecture:** Create a dedicated TimeLog API client (`timelog-api.ts`) that communicates with the external Azure Functions API at `boznet-timelogapi.azurewebsites.net`. The existing `commands/timelog.ts` placeholder will be filled in with subcommands (add, list, types, import) using the shared patterns from other commands.

**Tech Stack:** TypeScript, Bun, Commander.js, @clack/prompts (primary) + @inquirer/prompts (fallback toggle), fetch API

---

## Prerequisites

- Azure DevOps CLI refactor is complete ✅
- Config structure includes `orgId` and `projectId`
- User has TimeLog extension installed in their Azure DevOps organization

---

## Task 1: Add TimeLog Types to types.ts

**Files:**
- Modify: `src/azure-devops/types.ts` (append to end)

**Step 1: Add TimeLog interfaces**

Add these types at the end of `src/azure-devops/types.ts`:

```typescript
// ============= TimeLog Types (Third-Party Extension) =============

/** TimeLog API base URL */
export const TIMELOG_API_BASE = "https://boznet-timelogapi.azurewebsites.net/api";

/** Time type definition from TimeLog API */
export interface TimeType {
  timeTypeId: string;          // "3626529b-6efd-4c02-9800-861f9c0f9206"
  description: string;         // "Development", "Code Review", etc.
  projectId: string | null;    // null = org-wide
  isDefaultForProject: boolean;
  disabled: boolean;
}

/** Time log entry from GET response */
export interface TimeLogEntry {
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

/** User info for TimeLog API */
export interface TimeLogUser {
  userId: string;
  userName: string;
  userEmail: string;
}

/** Request body for creating a time log entry */
export interface CreateTimeLogRequest {
  minutes: number;             // 120 = 2 hours
  timeTypeDescription: string; // "Development" (display name, not UUID!)
  comment: string;             // "analýza, fixing"
  date: string;                // "2026-02-04"
  workItemId: number;          // 268935
  projectId: string;           // "de25c7dd-75d8-467a-bac0-f15fac9b560d"
  users: TimeLogUser[];
  userMakingChange: string;    // "John Doe"
}

/** Response from POST /timelogs/ */
export interface CreateTimeLogResponse {
  logsCreated: string[];       // ["9a016275-6d8f-4e6f-9f8f-052f34e5b177"]
}

/** TimeLog configuration stored in config.json */
export interface TimeLogConfig {
  functionsKey: string;        // API key for Azure Functions
  defaultUser?: TimeLogUser;   // Cached user info
}

/** Extended config with TimeLog settings */
export interface AzureConfigWithTimeLog extends AzureConfig {
  orgId?: string;              // Organization ID (GUID)
  timelog?: TimeLogConfig;
}

/** Options for timelog add command */
export interface TimeLogAddOptions {
  workitem?: string;
  hours?: string;
  minutes?: string;
  type?: string;
  date?: string;
  comment?: string;
  interactive?: boolean;
}

/** Options for timelog list command */
export interface TimeLogListOptions {
  workitem: string;
  format?: "ai" | "md" | "json";
}

/** JSON import file format */
export interface TimeLogImportFile {
  entries: Array<{
    workItemId: number;
    hours?: number;
    minutes?: number;
    timeType: string;
    date: string;
    comment?: string;
  }>;
}
```

**Step 2: Verify types compile**

Run: `tsgo --noEmit | rg "azure-devops/types"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/azure-devops/types.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog types

Add TypeScript interfaces for TimeLog third-party extension:
- TimeType, TimeLogEntry, TimeLogUser
- CreateTimeLogRequest/Response
- TimeLogConfig, AzureConfigWithTimeLog
- TimeLogAddOptions, TimeLogListOptions
- TimeLogImportFile for bulk import
EOF
)"
```

---

## Task 2: Create TimeLog API Client

**Files:**
- Create: `src/azure-devops/timelog-api.ts`

**Step 1: Create the TimeLog API client**

Create `src/azure-devops/timelog-api.ts`:

```typescript
/**
 * TimeLog API Client
 *
 * Client for the TimeLog third-party Azure DevOps extension.
 * API Host: boznet-timelogapi.azurewebsites.net
 */

import logger from "@app/logger";
import type {
  TimeType,
  TimeLogEntry,
  TimeLogUser,
  CreateTimeLogRequest,
  CreateTimeLogResponse,
  TIMELOG_API_BASE,
} from "@app/azure-devops/types";

export class TimeLogApi {
  private orgId: string;
  private projectId: string;
  private functionsKey: string;
  private currentUser: TimeLogUser;
  private baseUrl: string;

  constructor(
    orgId: string,
    projectId: string,
    functionsKey: string,
    currentUser: TimeLogUser
  ) {
    this.orgId = orgId;
    this.projectId = projectId;
    this.functionsKey = functionsKey;
    this.currentUser = currentUser;
    this.baseUrl = `https://boznet-timelogapi.azurewebsites.net/api/${orgId}`;
  }

  /**
   * Make an HTTP request to the TimeLog API
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const shortUrl = endpoint.slice(0, 60);

    logger.debug(`[timelog-api] ${method} ${shortUrl}`);
    const startTime = Date.now();

    const headers: Record<string, string> = {
      "x-functions-key": this.functionsKey,
      "x-timelog-usermakingchange": encodeURIComponent(this.currentUser.userName),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const elapsed = Date.now() - startTime;
    logger.debug(`[timelog-api] ${method} response: ${response.status} (${elapsed}ms)`);

    if (!response.ok) {
      const errorText = await response.text();
      logger.debug(`[timelog-api] Error: ${errorText.slice(0, 200)}`);
      throw new Error(`TimeLog API Error ${response.status}: ${errorText}`);
    }

    // Handle empty responses (e.g., DELETE)
    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text) as T;
  }

  /**
   * Get all available time types for the project
   */
  async getTimeTypes(): Promise<TimeType[]> {
    logger.debug("[timelog-api] Fetching time types");
    const types = await this.request<TimeType[]>(
      "GET",
      `/timetype/project/${this.projectId}`
    );
    const activeTypes = types.filter(t => !t.disabled);
    logger.debug(`[timelog-api] Found ${activeTypes.length} active time types`);
    return activeTypes;
  }

  /**
   * Get all time types for the organization (not project-specific)
   */
  async getAllTimeTypes(): Promise<TimeType[]> {
    logger.debug("[timelog-api] Fetching all org time types");
    return this.request<TimeType[]>("GET", "/timetype/project");
  }

  /**
   * Get time log entries for a work item
   */
  async getWorkItemTimeLogs(workItemId: number): Promise<TimeLogEntry[]> {
    logger.debug(`[timelog-api] Fetching time logs for work item #${workItemId}`);
    const entries = await this.request<TimeLogEntry[]>(
      "GET",
      `/timelog/project/${this.projectId}/workitem/${workItemId}`
    );
    logger.debug(`[timelog-api] Found ${entries.length} time log entries`);
    return entries;
  }

  /**
   * Create a new time log entry
   *
   * @param workItemId - The work item to log time against
   * @param minutes - Time in minutes (not hours!)
   * @param timeTypeDescription - Display name of time type (e.g., "Development")
   * @param date - Date in YYYY-MM-DD format
   * @param comment - Optional description of work performed
   * @returns IDs of created log entries
   */
  async createTimeLogEntry(
    workItemId: number,
    minutes: number,
    timeTypeDescription: string,
    date: string,
    comment: string = ""
  ): Promise<string[]> {
    logger.debug(`[timelog-api] Creating time log: ${minutes}min of "${timeTypeDescription}" for #${workItemId}`);

    const request: CreateTimeLogRequest = {
      minutes,
      timeTypeDescription,
      comment,
      date,
      workItemId,
      projectId: this.projectId,
      users: [this.currentUser],
      userMakingChange: this.currentUser.userName,
    };

    const response = await this.request<CreateTimeLogResponse>(
      "POST",
      "/timelogs/",
      request
    );

    logger.debug(`[timelog-api] Created ${response.logsCreated.length} time log entries`);
    return response.logsCreated;
  }

  /**
   * Delete a time log entry
   */
  async deleteTimeLogEntry(timeLogId: string): Promise<void> {
    logger.debug(`[timelog-api] Deleting time log: ${timeLogId}`);
    await this.request<void>("DELETE", `/timelogs/${timeLogId}`);
    logger.debug("[timelog-api] Time log deleted");
  }

  /**
   * Validate that a time type exists
   */
  async validateTimeType(description: string): Promise<TimeType | null> {
    const types = await this.getTimeTypes();
    return types.find(t =>
      t.description.toLowerCase() === description.toLowerCase()
    ) || null;
  }
}

/**
 * Convert hours and minutes to total minutes
 * Validates the --hours 0 --minutes rule
 */
export function convertToMinutes(
  hours: number | undefined,
  minutes: number | undefined
): number {
  // Rule: --minutes alone requires --hours to be explicitly set
  if (minutes !== undefined && hours === undefined) {
    throw new Error(
      "Cannot use --minutes without --hours. " +
      "Use --hours 0 --minutes N to confirm you meant only minutes."
    );
  }

  const h = hours ?? 0;
  const m = minutes ?? 0;
  const total = h * 60 + m;

  if (total <= 0) {
    throw new Error("Total time must be greater than 0 minutes");
  }

  return total;
}

/**
 * Format minutes as human-readable string
 */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}
```

**Step 2: Verify it compiles**

Run: `tsgo --noEmit | rg "timelog-api"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/azure-devops/timelog-api.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog API client

Create TimeLogApi class for third-party extension:
- getTimeTypes() - list available time types
- getWorkItemTimeLogs() - get entries for work item
- createTimeLogEntry() - log time against work item
- deleteTimeLogEntry() - remove entry
- validateTimeType() - check type exists

Also adds utility functions:
- convertToMinutes() - hours/minutes conversion with validation
- formatMinutes() - human-readable formatting
- getTodayDate() - default date helper
EOF
)"
```

---

## Task 3: Add Cache Support for TimeLog

**Files:**
- Modify: `src/azure-devops/cache.ts`

**Step 1: Add timetype cache TTL**

Add to `CACHE_TTL` object in `cache.ts`:

```typescript
export const CACHE_TTL = {
  query: "180 days",
  workitem: "180 days",
  dashboard: "180 days",
  queries: "30 days",
  project: "30 days",
  timetypes: "7 days",      // Time types rarely change
} as const;
```

**Step 2: Add cache functions for time types**

Add these functions to `cache.ts`:

```typescript
import type { TimeType } from "@app/azure-devops/types";

/**
 * Load cached time types
 */
export async function loadTimeTypesCache(projectId: string): Promise<TimeType[] | null> {
  await storage.ensureDirs();
  return storage.getCacheFile<TimeType[]>(`timetypes-${projectId}.json`, CACHE_TTL.timetypes);
}

/**
 * Save time types to cache
 */
export async function saveTimeTypesCache(projectId: string, types: TimeType[]): Promise<void> {
  await storage.ensureDirs();
  await storage.putCacheFile(`timetypes-${projectId}.json`, types, CACHE_TTL.timetypes);
}
```

**Step 3: Verify it compiles**

Run: `tsgo --noEmit | rg "cache.ts"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/azure-devops/cache.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog cache support

Add timetypes cache with 7-day TTL:
- loadTimeTypesCache()
- saveTimeTypesCache()
EOF
)"
```

---

## Task 4: Add Configuration Loading for TimeLog

**Files:**
- Modify: `src/azure-devops/utils.ts`

**Step 1: Add config helper for TimeLog**

Add this function to `utils.ts` (after `requireConfig`):

```typescript
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";

/**
 * Load config with TimeLog settings or exit with helpful error
 */
export function requireTimeLogConfig(): AzureConfigWithTimeLog {
  const config = loadConfig() as AzureConfigWithTimeLog | null;
  if (!config) {
    console.error(`
❌ No Azure DevOps configuration found.

Run configure with any Azure DevOps URL from your project:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
`);
    process.exit(1);
  }

  if (!config.orgId) {
    console.error(`
❌ Organization ID not found in config.

Re-run configure to update your config:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems" --force
`);
    process.exit(1);
  }

  if (!config.timelog?.functionsKey) {
    console.error(`
❌ TimeLog configuration not found.

Run the auto-configure command to fetch TimeLog settings:

  tools azure-devops timelog configure

This will automatically fetch the API key from Azure DevOps Extension Data API.

Alternatively, add manually to .claude/azure/config.json:

{
  "timelog": {
    "functionsKey": "<fetched-automatically>",
    "defaultUser": {
      "userId": "<your-user-id>",
      "userName": "<Your Name>",
      "userEmail": "<your-email>"
    }
  }
}
`);
    process.exit(1);
  }

  return config;
}

/**
 * Get current user for TimeLog or exit with helpful error
 */
export function requireTimeLogUser(config: AzureConfigWithTimeLog): TimeLogUser {
  const user = config.timelog?.defaultUser;
  if (!user) {
    console.error(`
❌ TimeLog user not configured.

Add defaultUser to .claude/azure/config.json timelog section:

"timelog": {
  "functionsKey": "...",
  "defaultUser": {
    "userId": "<your-azure-ad-object-id>",
    "userName": "<Your Display Name>",
    "userEmail": "<your-email@example.com>"
  }
}
`);
    process.exit(1);
  }
  return user;
}
```

**Step 2: Verify it compiles**

Run: `tsgo --noEmit | rg "utils.ts"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/azure-devops/utils.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog config helpers

Add utility functions:
- requireTimeLogConfig() - load config with TimeLog validation
- requireTimeLogUser() - get user info with helpful error
EOF
)"
```

---

## Task 4.5: Implement timelog configure Subcommand

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Add configure subcommand**

Add this subcommand to `commands/timelog.ts`:

```typescript
import { $ } from "bun";

timelog
  .command("configure")
  .description("Auto-fetch TimeLog API settings from Azure DevOps")
  .action(async () => {
    const config = loadConfig() as AzureConfigWithTimeLog | null;
    if (!config?.org) {
      console.error("❌ Run 'tools azure-devops configure <url>' first");
      process.exit(1);
    }

    // Extract org name from URL (e.g., "MyOrg" from "https://dev.azure.com/MyOrg")
    const orgMatch = config.org.match(/dev\.azure\.com\/([^/]+)/);
    const orgName = orgMatch?.[1];
    if (!orgName) {
      console.error("❌ Could not extract organization name from config.org");
      process.exit(1);
    }

    console.log("Fetching TimeLog extension settings...");

    try {
      const result = await $`az rest --method GET --resource "499b84ac-1321-427f-aa17-267ca6975798" --uri "https://extmgmt.dev.azure.com/${orgName}/_apis/ExtensionManagement/InstalledExtensions/TimeLog/time-logging/Data/Scopes/Default/Current/Collections/%24settings/Documents?api-version=7.1-preview"`.quiet();

      const data = JSON.parse(result.text());
      const configDoc = data.find((d: { id: string }) => d.id === "Config");

      if (!configDoc?.value) {
        console.error("❌ TimeLog extension not configured in Azure DevOps");
        process.exit(1);
      }

      const settings = JSON.parse(configDoc.value);
      const apiKey = settings.find((s: { id: string }) => s.id === "ApiKeyTextBox")?.value;

      if (!apiKey) {
        console.error("❌ API key not found in TimeLog settings");
        process.exit(1);
      }

      // Update config with TimeLog settings
      const configPath = findConfigPath();
      if (!configPath) {
        console.error("❌ Config file not found");
        process.exit(1);
      }

      const existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      existingConfig.timelog = existingConfig.timelog || {};
      existingConfig.timelog.functionsKey = apiKey;

      writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));
      console.log("✔ TimeLog API key saved to config");
      console.log("\nNext: Add your user info to config.json:");
      console.log('  "timelog": {');
      console.log('    "functionsKey": "...",');
      console.log('    "defaultUser": {');
      console.log('      "userId": "<your-azure-ad-object-id>",');
      console.log('      "userName": "<Your Name>",');
      console.log('      "userEmail": "<your-email>"');
      console.log('    }');
      console.log('  }');
    } catch (error) {
      console.error("❌ Failed to fetch TimeLog settings:", (error as Error).message);
      process.exit(1);
    }
  });
```

**Step 2: Test the command**

Run: `tools azure-devops timelog configure`
Expected: API key fetched and saved to config

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add timelog configure command

Auto-fetch TimeLog API key from Azure DevOps Extension Data API.
No more manual HAR capture needed!
EOF
)"
```

---

## Task 5: Implement timelog types Subcommand

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Implement the types subcommand**

Replace the placeholder `types` action in `commands/timelog.ts`:

```typescript
import logger from "@app/logger";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi, formatMinutes } from "@app/azure-devops/timelog-api";
import { loadTimeTypesCache, saveTimeTypesCache } from "@app/azure-devops/cache";
import type { TimeType } from "@app/azure-devops/types";

// Inside registerTimelogCommand, replace types action:
timelog
  .command("types")
  .description("List available time types")
  .option("--force", "Bypass cache")
  .option("--format <format>", "Output format: ai|json", "ai")
  .action(async (options: { force?: boolean; format?: string }) => {
    const config = requireTimeLogConfig();
    const user = requireTimeLogUser(config);

    // Check cache first
    let types: TimeType[] | null = null;
    if (!options.force) {
      types = await loadTimeTypesCache(config.projectId);
      if (types) {
        logger.debug("[timelog] Using cached time types");
      }
    }

    // Fetch from API if needed
    if (!types) {
      const api = new TimeLogApi(
        config.orgId!,
        config.projectId,
        config.timelog!.functionsKey,
        user
      );
      types = await api.getTimeTypes();
      await saveTimeTypesCache(config.projectId, types);
    }

    // Output
    if (options.format === "json") {
      console.log(JSON.stringify(types, null, 2));
      return;
    }

    // AI-friendly format
    console.log("Available Time Types:");
    console.log("=====================");
    for (const type of types) {
      const defaultMark = type.isDefaultForProject ? " (default)" : "";
      console.log(`  - ${type.description}${defaultMark}`);
    }
    console.log(`\nTotal: ${types.length} time types`);
  });
```

**Step 2: Test the command**

Run: `tools azure-devops timelog types`
Expected: List of time types or config error

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Implement timelog types command

List available time types from TimeLog API:
- Caches results for 7 days
- Supports --force to bypass cache
- Supports --format json for machine output
EOF
)"
```

---

## Task 6: Implement timelog list Subcommand

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Implement the list subcommand**

Replace the placeholder `list` action:

```typescript
timelog
  .command("list")
  .description("List time logs for a work item")
  .requiredOption("-w, --workitem <id>", "Work item ID")
  .option("--format <format>", "Output format: ai|md|json", "ai")
  .action(async (options: { workitem: string; format?: string }) => {
    const config = requireTimeLogConfig();
    const user = requireTimeLogUser(config);
    const workItemId = parseInt(options.workitem, 10);

    if (isNaN(workItemId)) {
      console.error("❌ Invalid work item ID");
      process.exit(1);
    }

    const api = new TimeLogApi(
      config.orgId!,
      config.projectId,
      config.timelog!.functionsKey,
      user
    );

    const entries = await api.getWorkItemTimeLogs(workItemId);

    if (options.format === "json") {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log(`No time logs found for work item #${workItemId}`);
      return;
    }

    // Sort by date descending
    entries.sort((a, b) => b.date.localeCompare(a.date));

    // Calculate totals
    const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
    const byType: Record<string, number> = {};
    for (const entry of entries) {
      byType[entry.timeTypeDescription] = (byType[entry.timeTypeDescription] || 0) + entry.minutes;
    }

    if (options.format === "md") {
      console.log(`## Time Logs for #${workItemId}\n`);
      console.log(`| Date | Type | Time | User | Comment |`);
      console.log(`|------|------|------|------|---------|`);
      for (const e of entries) {
        console.log(`| ${e.date} | ${e.timeTypeDescription} | ${formatMinutes(e.minutes)} | ${e.userName} | ${e.comment || "-"} |`);
      }
      console.log(`\n**Total: ${formatMinutes(totalMinutes)}**`);
    } else {
      // AI format
      console.log(`Time Logs for Work Item #${workItemId}`);
      console.log("=".repeat(40));
      for (const e of entries) {
        console.log(`\n${e.date} - ${formatMinutes(e.minutes)} (${e.timeTypeDescription})`);
        console.log(`  User: ${e.userName}`);
        if (e.comment) console.log(`  Comment: ${e.comment}`);
      }
      console.log(`\n${"=".repeat(40)}`);
      console.log(`Total: ${formatMinutes(totalMinutes)}`);
      console.log("\nBy Type:");
      for (const [type, mins] of Object.entries(byType)) {
        console.log(`  ${type}: ${formatMinutes(mins)}`);
      }
    }
  });
```

**Step 2: Test the command**

Run: `tools azure-devops timelog list -w 268935`
Expected: List of time entries or empty message

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Implement timelog list command

List time log entries for a work item:
- Shows date, type, duration, user, comment
- Calculates total time and breakdown by type
- Supports --format ai|md|json
EOF
)"
```

---

## Task 7: Implement timelog add Subcommand (Non-Interactive)

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Implement the add subcommand (non-interactive mode)**

Replace the placeholder `add` action:

```typescript
import { convertToMinutes, getTodayDate } from "@app/azure-devops/timelog-api";

timelog
  .command("add")
  .description("Add a time log entry")
  .option("-w, --workitem <id>", "Work item ID")
  .option("-h, --hours <hours>", "Hours to log")
  .option("-m, --minutes <minutes>", "Additional minutes (requires --hours)")
  .option("-t, --type <type>", 'Time type (e.g., "Development")')
  .option("-d, --date <date>", "Date (YYYY-MM-DD, default: today)")
  .option("-c, --comment <text>", "Comment/description")
  .option("-i, --interactive", "Interactive mode with prompts")
  .option("-?, --help-full", "Show detailed help")
  .action(async (options: {
    workitem?: string;
    hours?: string;
    minutes?: string;
    type?: string;
    date?: string;
    comment?: string;
    interactive?: boolean;
    helpFull?: boolean;
  }) => {
    if (options.helpFull) {
      showAddHelp();
      return;
    }

    const config = requireTimeLogConfig();
    const user = requireTimeLogUser(config);

    // Interactive mode
    if (options.interactive) {
      await runInteractiveAdd(config, user, options.workitem);
      return;
    }

    // Validate required fields
    if (!options.workitem || !options.hours || !options.type) {
      console.error(`
❌ Missing required options for non-interactive mode.

Required: --workitem, --hours, --type

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"

Or use interactive mode:
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
      process.exit(1);
    }

    const workItemId = parseInt(options.workitem, 10);
    if (isNaN(workItemId)) {
      console.error("❌ Invalid work item ID");
      process.exit(1);
    }

    // Convert hours/minutes
    let totalMinutes: number;
    try {
      totalMinutes = convertToMinutes(
        options.hours ? parseFloat(options.hours) : undefined,
        options.minutes ? parseInt(options.minutes, 10) : undefined
      );
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }

    const api = new TimeLogApi(
      config.orgId!,
      config.projectId,
      config.timelog!.functionsKey,
      user
    );

    // Validate time type exists
    const validType = await api.validateTimeType(options.type);
    if (!validType) {
      const types = await api.getTimeTypes();
      console.error(`
❌ Unknown time type: "${options.type}"

Available types:
${types.map(t => `  - ${t.description}`).join("\n")}
`);
      process.exit(1);
    }

    const date = options.date || getTodayDate();
    const comment = options.comment || "";

    // Create the entry
    const ids = await api.createTimeLogEntry(
      workItemId,
      totalMinutes,
      validType.description,  // Use exact casing from API
      date,
      comment
    );

    console.log(`✔ Time logged successfully!`);
    console.log(`  Work Item: #${workItemId}`);
    console.log(`  Time: ${formatMinutes(totalMinutes)}`);
    console.log(`  Type: ${validType.description}`);
    console.log(`  Date: ${date}`);
    if (comment) console.log(`  Comment: ${comment}`);
    console.log(`  Entry ID: ${ids[0]}`);
  });

function showAddHelp(): void {
  console.log(`
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

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
  tools azure-devops timelog add -w 268935 -h 0 -m 30 -t "Test" -d 2026-02-03
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
}
```

**Step 2: Test the command**

Run: `tools azure-devops timelog add -w 268935 -h 0 -m 1 -t "Development" -c "Test entry"`
Expected: Success message with entry details

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Implement timelog add command (non-interactive)

Add time log entries from CLI:
- Validates work item ID, hours/minutes, time type
- Enforces --hours 0 --minutes N rule for minutes-only
- Shows helpful error with available time types
- Includes detailed --help-full output
EOF
)"
```

---

## Task 8: Create Interactive Prompts (Clack)

**Files:**
- Create: `src/azure-devops/timelog-prompts-clack.ts`

**Step 1: Create clack prompts file**

Create `src/azure-devops/timelog-prompts-clack.ts`:

```typescript
/**
 * TimeLog Interactive Prompts - @clack/prompts implementation
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { TimeLogApi, formatMinutes, getTodayDate, convertToMinutes } from "@app/azure-devops/timelog-api";
import type { TimeType, TimeLogUser, AzureConfigWithTimeLog } from "@app/azure-devops/types";

export async function runInteractiveAddClack(
  config: AzureConfigWithTimeLog,
  user: TimeLogUser,
  prefilledWorkItem?: string
): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" TimeLog - Add Entry ")));

  const api = new TimeLogApi(
    config.orgId!,
    config.projectId,
    config.timelog!.functionsKey,
    user
  );

  // Fetch time types
  const spinner = p.spinner();
  spinner.start("Loading time types...");
  const types = await api.getTimeTypes();
  spinner.stop("Time types loaded");

  // Work item ID
  let workItemId: number;
  if (prefilledWorkItem) {
    workItemId = parseInt(prefilledWorkItem, 10);
    p.log.info(`Work Item: #${workItemId}`);
  } else {
    const workItemInput = await p.text({
      message: "Work Item ID:",
      placeholder: "268935",
      validate: (value) => {
        if (!value) return "Work item ID is required";
        if (isNaN(parseInt(value, 10))) return "Must be a number";
        return undefined;
      },
    });
    if (p.isCancel(workItemInput)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    workItemId = parseInt(workItemInput, 10);
  }

  // Time type
  const typeOptions = types.map(t => ({
    value: t.description,
    label: t.description,
    hint: t.isDefaultForProject ? "default" : undefined,
  }));

  const selectedType = await p.select({
    message: "Time Type:",
    options: typeOptions,
    initialValue: types.find(t => t.isDefaultForProject)?.description,
  });
  if (p.isCancel(selectedType)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Hours
  const hoursInput = await p.text({
    message: "Hours:",
    placeholder: "2",
    validate: (value) => {
      if (!value) return "Hours is required (use 0 for minutes only)";
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) return "Must be a non-negative number";
      return undefined;
    },
  });
  if (p.isCancel(hoursInput)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  const hours = parseFloat(hoursInput);

  // Minutes (optional)
  let minutes = 0;
  if (hours === 0 || hours % 1 !== 0) {
    // If hours is 0 or has decimals, skip additional minutes
  } else {
    const minutesInput = await p.text({
      message: "Additional minutes (optional):",
      placeholder: "0",
      initialValue: "0",
    });
    if (p.isCancel(minutesInput)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    minutes = parseInt(minutesInput || "0", 10);
  }

  const totalMinutes = convertToMinutes(hours, minutes);

  // Date
  const dateInput = await p.text({
    message: "Date:",
    placeholder: getTodayDate(),
    initialValue: getTodayDate(),
    validate: (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return "Use YYYY-MM-DD format";
      }
      return undefined;
    },
  });
  if (p.isCancel(dateInput)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Comment
  const commentInput = await p.text({
    message: "Comment (optional):",
    placeholder: "Description of work performed",
  });
  if (p.isCancel(commentInput)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  const comment = commentInput || "";

  // Confirm
  p.log.info(pc.dim("─".repeat(40)));
  p.log.info(`Work Item: #${workItemId}`);
  p.log.info(`Time: ${formatMinutes(totalMinutes)}`);
  p.log.info(`Type: ${selectedType}`);
  p.log.info(`Date: ${dateInput}`);
  if (comment) p.log.info(`Comment: ${comment}`);
  p.log.info(pc.dim("─".repeat(40)));

  const confirm = await p.confirm({
    message: "Create this time log entry?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Create entry
  spinner.start("Creating time log entry...");
  const ids = await api.createTimeLogEntry(
    workItemId,
    totalMinutes,
    selectedType as string,
    dateInput,
    comment
  );
  spinner.stop("Time log created!");

  p.outro(pc.green(`✔ Entry ID: ${ids[0]}`));
}
```

**Step 2: Verify it compiles**

Run: `tsgo --noEmit | rg "timelog-prompts"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/azure-devops/timelog-prompts-clack.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog interactive prompts (clack)

Interactive mode using @clack/prompts:
- Work item ID input (with pre-fill support)
- Time type selector with default highlighting
- Hours/minutes input with validation
- Date input with today as default
- Optional comment
- Confirmation before creating
EOF
)"
```

---

## Task 9: Create Interactive Prompts (Inquirer Fallback)

**Files:**
- Create: `src/azure-devops/timelog-prompts-inquirer.ts`

**Step 1: Create inquirer prompts file**

Create `src/azure-devops/timelog-prompts-inquirer.ts`:

```typescript
/**
 * TimeLog Interactive Prompts - @inquirer/prompts implementation (fallback)
 */

import { input, select, confirm } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import { TimeLogApi, formatMinutes, getTodayDate, convertToMinutes } from "@app/azure-devops/timelog-api";
import type { TimeLogUser, AzureConfigWithTimeLog } from "@app/azure-devops/types";

export async function runInteractiveAddInquirer(
  config: AzureConfigWithTimeLog,
  user: TimeLogUser,
  prefilledWorkItem?: string
): Promise<void> {
  console.log("\n📝 TimeLog - Add Entry\n");

  try {
    const api = new TimeLogApi(
      config.orgId!,
      config.projectId,
      config.timelog!.functionsKey,
      user
    );

    // Fetch time types
    console.log("Loading time types...");
    const types = await api.getTimeTypes();

    // Work item ID
    let workItemId: number;
    if (prefilledWorkItem) {
      workItemId = parseInt(prefilledWorkItem, 10);
      console.log(`Work Item: #${workItemId}`);
    } else {
      const workItemInput = await input({
        message: "Work Item ID:",
        validate: (value) => {
          if (!value) return "Work item ID is required";
          if (isNaN(parseInt(value, 10))) return "Must be a number";
          return true;
        },
      });
      workItemId = parseInt(workItemInput, 10);
    }

    // Time type
    const defaultType = types.find(t => t.isDefaultForProject);
    const selectedType = await select({
      message: "Time Type:",
      choices: types.map(t => ({
        value: t.description,
        name: t.description + (t.isDefaultForProject ? " (default)" : ""),
      })),
      default: defaultType?.description,
    });

    // Hours
    const hoursInput = await input({
      message: "Hours:",
      default: "1",
      validate: (value) => {
        if (!value) return "Hours is required (use 0 for minutes only)";
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) return "Must be a non-negative number";
        return true;
      },
    });
    const hours = parseFloat(hoursInput);

    // Minutes
    let minutes = 0;
    if (hours === Math.floor(hours)) {
      const minutesInput = await input({
        message: "Additional minutes:",
        default: "0",
      });
      minutes = parseInt(minutesInput || "0", 10);
    }

    const totalMinutes = convertToMinutes(hours, minutes);

    // Date
    const dateInput = await input({
      message: "Date (YYYY-MM-DD):",
      default: getTodayDate(),
      validate: (value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return "Use YYYY-MM-DD format";
        }
        return true;
      },
    });

    // Comment
    const comment = await input({
      message: "Comment (optional):",
    });

    // Confirm
    console.log("\n─".repeat(40));
    console.log(`Work Item: #${workItemId}`);
    console.log(`Time: ${formatMinutes(totalMinutes)}`);
    console.log(`Type: ${selectedType}`);
    console.log(`Date: ${dateInput}`);
    if (comment) console.log(`Comment: ${comment}`);
    console.log("─".repeat(40));

    const confirmed = await confirm({
      message: "Create this time log entry?",
      default: true,
    });

    if (!confirmed) {
      console.log("Cancelled");
      process.exit(0);
    }

    // Create entry
    console.log("\nCreating time log entry...");
    const ids = await api.createTimeLogEntry(
      workItemId,
      totalMinutes,
      selectedType,
      dateInput,
      comment
    );

    console.log(`\n✔ Time log created! Entry ID: ${ids[0]}`);
  } catch (error) {
    if (error instanceof ExitPromptError) {
      console.log("\nCancelled");
      process.exit(0);
    }
    throw error;
  }
}
```

**Step 2: Verify it compiles**

Run: `tsgo --noEmit | rg "timelog-prompts"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/azure-devops/timelog-prompts-inquirer.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Add TimeLog interactive prompts (inquirer fallback)

Alternative implementation using @inquirer/prompts:
- Same flow as clack version
- Fallback for environments where clack doesn't work
EOF
)"
```

---

## Task 10: Wire Up Interactive Mode

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Add USE_CLACK toggle and wire up interactive mode**

Add at the top of `commands/timelog.ts`:

```typescript
import { runInteractiveAddClack } from "@app/azure-devops/timelog-prompts-clack";
import { runInteractiveAddInquirer } from "@app/azure-devops/timelog-prompts-inquirer";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";

// Toggle between prompt implementations
// 1 = @clack/prompts (preferred)
// 0 = @inquirer/prompts (fallback)
const USE_CLACK = 1;

async function runInteractiveAdd(
  config: AzureConfigWithTimeLog,
  user: TimeLogUser,
  prefilledWorkItem?: string
): Promise<void> {
  if (USE_CLACK) {
    await runInteractiveAddClack(config, user, prefilledWorkItem);
  } else {
    await runInteractiveAddInquirer(config, user, prefilledWorkItem);
  }
}
```

**Step 2: Test interactive mode**

Run: `tools azure-devops timelog add -i`
Expected: Interactive prompts appear

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Wire up timelog interactive mode

Add USE_CLACK toggle to switch between prompt implementations:
- USE_CLACK=1: @clack/prompts (default)
- USE_CLACK=0: @inquirer/prompts (fallback)
EOF
)"
```

---

## Task 11: Implement timelog import Subcommand

**Files:**
- Modify: `src/azure-devops/commands/timelog.ts`

**Step 1: Implement the import subcommand**

Replace the placeholder `import` action:

```typescript
import { readFileSync, existsSync } from "fs";
import type { TimeLogImportFile } from "@app/azure-devops/types";

timelog
  .command("import")
  .description("Import time logs from JSON file")
  .argument("<file>", "JSON file path")
  .option("--dry-run", "Validate without creating entries")
  .action(async (file: string, options: { dryRun?: boolean }) => {
    const config = requireTimeLogConfig();
    const user = requireTimeLogUser(config);

    if (!existsSync(file)) {
      console.error(`❌ File not found: ${file}`);
      process.exit(1);
    }

    let data: TimeLogImportFile;
    try {
      const content = readFileSync(file, "utf-8");
      data = JSON.parse(content);
    } catch (e) {
      console.error(`❌ Invalid JSON: ${(e as Error).message}`);
      process.exit(1);
    }

    if (!data.entries || !Array.isArray(data.entries)) {
      console.error(`❌ Invalid format: expected { entries: [...] }`);
      process.exit(1);
    }

    const api = new TimeLogApi(
      config.orgId!,
      config.projectId,
      config.timelog!.functionsKey,
      user
    );

    // Validate time types
    const types = await api.getTimeTypes();
    const typeNames = new Set(types.map(t => t.description.toLowerCase()));

    const errors: string[] = [];
    const validEntries: Array<{
      workItemId: number;
      minutes: number;
      timeType: string;
      date: string;
      comment: string;
    }> = [];

    for (let i = 0; i < data.entries.length; i++) {
      const entry = data.entries[i];
      const idx = i + 1;

      // Validate work item ID
      if (!entry.workItemId || isNaN(entry.workItemId)) {
        errors.push(`Entry ${idx}: Missing or invalid workItemId`);
        continue;
      }

      // Validate time
      let minutes: number;
      try {
        minutes = convertToMinutes(entry.hours, entry.minutes);
      } catch (e) {
        errors.push(`Entry ${idx}: ${(e as Error).message}`);
        continue;
      }

      // Validate time type
      if (!entry.timeType) {
        errors.push(`Entry ${idx}: Missing timeType`);
        continue;
      }
      if (!typeNames.has(entry.timeType.toLowerCase())) {
        errors.push(`Entry ${idx}: Unknown time type "${entry.timeType}"`);
        continue;
      }

      // Validate date
      if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        errors.push(`Entry ${idx}: Invalid date format (use YYYY-MM-DD)`);
        continue;
      }

      // Find exact type name (case-sensitive from API)
      const exactType = types.find(
        t => t.description.toLowerCase() === entry.timeType.toLowerCase()
      );

      validEntries.push({
        workItemId: entry.workItemId,
        minutes,
        timeType: exactType!.description,
        date: entry.date,
        comment: entry.comment || "",
      });
    }

    // Report validation errors
    if (errors.length > 0) {
      console.error("❌ Validation errors:");
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      if (validEntries.length === 0) {
        process.exit(1);
      }
      console.log(`\n${validEntries.length} entries are valid.\n`);
    }

    if (options.dryRun) {
      console.log("✔ Dry run complete. Valid entries:");
      for (const e of validEntries) {
        console.log(`  #${e.workItemId}: ${formatMinutes(e.minutes)} ${e.timeType} on ${e.date}`);
      }
      return;
    }

    // Create entries
    console.log(`Creating ${validEntries.length} time log entries...`);
    let created = 0;
    const failed: string[] = [];

    for (const entry of validEntries) {
      try {
        await api.createTimeLogEntry(
          entry.workItemId,
          entry.minutes,
          entry.timeType,
          entry.date,
          entry.comment
        );
        created++;
        console.log(`  ✔ #${entry.workItemId}: ${formatMinutes(entry.minutes)}`);
      } catch (e) {
        failed.push(`#${entry.workItemId}: ${(e as Error).message}`);
      }
    }

    console.log(`\n✔ Created ${created}/${validEntries.length} entries`);
    if (failed.length > 0) {
      console.error("\nFailed:");
      for (const f of failed) {
        console.error(`  - ${f}`);
      }
    }
  });
```

**Step 2: Test with a sample file**

Create test file:
```json
{
  "entries": [
    {
      "workItemId": 268935,
      "hours": 1,
      "timeType": "Development",
      "date": "2026-02-04",
      "comment": "Test import"
    }
  ]
}
```

Run: `tools azure-devops timelog import test-entries.json --dry-run`
Expected: Validation passes

**Step 3: Commit**

```bash
git add src/azure-devops/commands/timelog.ts
git commit -m "$(cat <<'EOF'
feat(azure-devops): Implement timelog import command

Bulk import time logs from JSON file:
- Validates all entries before creating
- Reports validation errors with line numbers
- Supports --dry-run for validation only
- Creates entries sequentially with progress
EOF
)"
```

---

## Task 12: Update README Documentation

**Files:**
- Modify: `src/azure-devops/README.md`

**Step 1: Add TimeLog documentation section**

Add to README after existing content:

```markdown
## TimeLog Commands

The TimeLog feature integrates with the third-party TimeLog extension for Azure DevOps.

### Prerequisites

1. TimeLog extension must be installed in your Azure DevOps organization
2. Run auto-configuration to fetch TimeLog settings:

```bash
tools azure-devops timelog configure
```

This automatically fetches the API key from Azure DevOps Extension Data API and saves it to `.claude/azure/config.json`.

The config will look like:

```json
{
  "timelog": {
    "functionsKey": "<auto-fetched>",
    "defaultUser": {
      "userId": "<your-azure-ad-object-id>",
      "userName": "<Your Display Name>",
      "userEmail": "<your-email@example.com>"
    }
  }
}
```

### Commands

```bash
# List available time types
tools azure-devops timelog types
tools azure-devops timelog types --format json

# List time logs for a work item
tools azure-devops timelog list -w 268935
tools azure-devops timelog list -w 268935 --format md

# Add time log entry (quick)
tools azure-devops timelog add -w 268935 -h 2 -t "Development"
tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
tools azure-devops timelog add -w 268935 -h 0 -m 30 -t "Test"

# Add time log entry (interactive)
tools azure-devops timelog add -i
tools azure-devops timelog add -w 268935 -i

# Bulk import from JSON file
tools azure-devops timelog import entries.json
tools azure-devops timelog import entries.json --dry-run
```

### Import File Format

```json
{
  "entries": [
    {
      "workItemId": 268935,
      "hours": 2,
      "timeType": "Development",
      "date": "2026-02-04",
      "comment": "Implemented feature X"
    },
    {
      "workItemId": 268936,
      "hours": 1,
      "minutes": 30,
      "timeType": "Code Review",
      "date": "2026-02-04",
      "comment": "PR #123 review"
    }
  ]
}
```

### Hours vs Minutes

The TimeLog API uses minutes internally:
- `--hours 2` → 120 minutes
- `--hours 1 --minutes 30` → 90 minutes
- `--minutes 30` → ERROR (ambiguous)
- `--hours 0 --minutes 30` → 30 minutes (explicit)
```

**Step 2: Commit**

```bash
git add src/azure-devops/README.md
git commit -m "$(cat <<'EOF'
docs(azure-devops): Add TimeLog documentation

Document TimeLog commands:
- Configuration setup with functionsKey and user info
- types, list, add, import commands
- Import file format
- Hours vs minutes explanation
EOF
)"
```

---

## Task 13: Update Plugin Skill Documentation

**Files:**
- Modify: `plugins/genesis-tools/skills/azure-devops/SKILL.md`

**Step 1: Add TimeLog section to skill**

Add after the existing content:

```markdown
## TimeLog Operations

### List Time Types

```bash
tools azure-devops timelog types              # AI-friendly list
tools azure-devops timelog types --format json  # JSON output
```

### List Time Logs

```bash
tools azure-devops timelog list -w <workItemId>
tools azure-devops timelog list -w 268935 --format md
```

### Add Time Log Entry

```bash
# Quick mode (all options on CLI)
tools azure-devops timelog add -w <id> -h <hours> -t <type>
tools azure-devops timelog add -w 268935 -h 2 -t "Development"
tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"

# Interactive mode
tools azure-devops timelog add -i
tools azure-devops timelog add -w 268935 -i
```

### Import Time Logs

```bash
tools azure-devops timelog import entries.json
tools azure-devops timelog import entries.json --dry-run
```

| User Request | Action |
|--------------|--------|
| "Log 2 hours on task 268935" | `tools azure-devops timelog add -w 268935 -h 2 -t "Development"` |
| "What time types are available?" | `tools azure-devops timelog types` |
| "Show time logged on 268935" | `tools azure-devops timelog list -w 268935` |
| "Help me log time" | `tools azure-devops timelog add -i` |
```

**Step 2: Commit**

```bash
git add plugins/genesis-tools/skills/azure-devops/SKILL.md
git commit -m "$(cat <<'EOF'
docs(genesis-tools): Add TimeLog to azure-devops skill

Add TimeLog commands to skill documentation:
- timelog types, list, add, import
- User request to action mapping
EOF
)"
```

---

## Task 14: Final Integration Test

**Files:** None (testing only)

**Step 1: Run all commands**

```bash
# Test help
tools azure-devops timelog --help
tools azure-devops timelog add --help-full

# Test types
tools azure-devops timelog types

# Test list
tools azure-devops timelog list -w 268935

# Test add (with minimal time to avoid cluttering real data)
tools azure-devops timelog add -w 268935 -h 0 -m 1 -t "Development" -c "Integration test - delete me"

# Verify it was created
tools azure-devops timelog list -w 268935

# Test interactive (manual)
# tools azure-devops timelog add -i
```

**Step 2: Verify TypeScript compilation**

Run: `tsgo --noEmit | rg "azure-devops"`
Expected: No errors

**Step 3: Final commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(azure-devops): Complete TimeLog implementation

TimeLog time logging for Azure DevOps work items:
- timelog types - list available time types
- timelog list - show entries for work item
- timelog add - create entries (CLI or interactive)
- timelog import - bulk import from JSON

Uses third-party TimeLog extension API at
boznet-timelogapi.azurewebsites.net
EOF
)"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add TimeLog types | types.ts |
| 2 | Create TimeLog API client | timelog-api.ts (new) |
| 3 | Add cache support | cache.ts |
| 4 | Add config helpers | utils.ts |
| 5 | Implement `types` command | commands/timelog.ts |
| 6 | Implement `list` command | commands/timelog.ts |
| 7 | Implement `add` (non-interactive) | commands/timelog.ts |
| 8 | Create clack prompts | timelog-prompts-clack.ts (new) |
| 9 | Create inquirer prompts | timelog-prompts-inquirer.ts (new) |
| 10 | Wire up interactive mode | commands/timelog.ts |
| 11 | Implement `import` command | commands/timelog.ts |
| 12 | Update README | README.md |
| 13 | Update skill docs | SKILL.md |
| 14 | Integration test | - |

---

**Plan complete and saved to `.claude/plans/2026-02-04-AzureDevops-Timelog.super.md`. Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**

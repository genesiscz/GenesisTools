# Timely CLI Tool - Implementation Plan

## Overview

A CLI tool to interact with Timely time tracking app, featuring OAuth2 authentication, persistent storage, caching with TTL, and various commands for managing accounts, projects, and time entries.

---

## Part 1: Storage Utility (`src/utils/storage/storage.ts`)

### Purpose
A reusable utility class that provides:
1. Tool-specific directory management in `~/.genesis-tools/<toolname>/`
2. Persistent JSON config storage (`config.json`)
3. Cache file management with TTL support

### Directory Structure
```
~/.genesis-tools/
└── <toolname>/
    ├── config.json        # Persistent configuration
    └── cache/             # Cache directory
        ├── suggested_entries/
        │   └── suggested_entries-2025-11-01.json
        └── <other-cache-files>
```

### Class: `Storage`

```typescript
class Storage {
    constructor(toolName: string)

    // Directory Management
    getBaseDir(): string                    // ~/.genesis-tools/<toolname>
    getCacheDir(): string                   // ~/.genesis-tools/<toolname>/cache
    ensureDirs(): Promise<void>             // Create all required directories

    // Config Management
    getConfig<T>(): Promise<T | null>                      // Read entire config.json
    setConfig<T>(key: string, value: T): Promise<void>     // Merge value into config
    getConfigValue<T>(key: string): Promise<T | undefined> // Get specific config key
    clearConfig(): Promise<void>                           // Delete config.json

    // Cache Management
    putFile(relativePath: string, content: string): Promise<void>
    getFile(relativePath: string): Promise<string | null>
    getFileOrPut<T>(
        relativePath: string,
        fetcher: () => Promise<T>,
        ttl: string  // e.g., "5 days", "1 hour", "30 minutes"
    ): Promise<T>
    deleteFile(relativePath: string): Promise<void>
    clearCache(): Promise<void>

    // Helpers
    parseTTL(ttl: string): number           // Convert TTL string to milliseconds
    isExpired(filePath: string, ttlMs: number): Promise<boolean>
}
```

### TTL Format Support
- `"5 days"` → 5 * 24 * 60 * 60 * 1000
- `"1 hour"` / `"2 hours"` → N * 60 * 60 * 1000
- `"30 minutes"` → 30 * 60 * 1000
- `"1 week"` → 7 * 24 * 60 * 60 * 1000

---

## Part 2: Timely Tool (`src/timely/`)

### Directory Structure
```
src/timely/
├── Plan.md                      # This file
├── index.ts                     # Main CLI entry point
├── api/
│   ├── client.ts               # HTTP client with OAuth2 token handling
│   ├── endpoints/
│   │   ├── accounts.ts         # Account-related API calls
│   │   ├── projects.ts         # Project-related API calls
│   │   ├── events.ts           # Event/time entry API calls
│   │   ├── users.ts            # User-related API calls
│   │   ├── clients.ts          # Client-related API calls
│   │   └── suggested.ts        # Suggested entries (web scraping endpoint)
│   └── types.ts                # API response types
├── commands/
│   ├── login.ts                # OAuth2 login flow
│   ├── logout.ts               # Clear tokens
│   ├── accounts.ts             # List/select accounts
│   ├── projects.ts             # List/select projects
│   ├── export-month.ts         # Export month's time entries
│   ├── events.ts               # List/create events
│   ├── status.ts               # Show current config status
│   └── cache.ts                # Cache management commands
├── types/
│   ├── config.ts               # Config schema types
│   ├── api.ts                  # API types (accounts, projects, events, etc.)
│   └── cli.ts                  # CLI argument types
└── utils/
    ├── auth.ts                 # OAuth2 helpers
    ├── date.ts                 # Date parsing utilities
    └── display.ts              # Output formatting
```

---

## Part 3: TypeScript Types

### Config Types (`types/config.ts`)

```typescript
interface TimelyConfig {
    oauth2?: OAuth2Tokens;
    accounts?: TimelyAccount[];
    selectedAccountId?: number;
    projects?: TimelyProject[];
    selectedProjectId?: number;
    user?: TimelyUser;
}

interface OAuth2Tokens {
    access_token: string;
    token_type: string;
    refresh_token: string;
    created_at?: number;
    expires_at?: number;
}

interface OAuthApplication {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
}
```

### API Types (`types/api.ts`)

```typescript
// Currency
interface Currency {
    id: string;
    name: string;
    iso_code: string;
    symbol: string;
    symbol_first: boolean;
}

// Logo/Avatar
interface Logo {
    large_retina: string;
    medium_retina: string;
    small_retina: string;
    brand_logo: boolean;
}

interface Avatar {
    large_retina: string;
    large: string;
    medium_retina: string;
    medium: string;
    timeline: string;
}

// Feature
interface Feature {
    name: string;
    days: number;
}

// Capacity
interface Capacity {
    hours: number;
    minutes: number;
    seconds: number;
    formatted: string;
    total_hours: number;
    total_seconds: number;
    total_minutes: number;
}

// Account
interface TimelyAccount {
    id: number;
    name: string;
    color: string;
    currency: Currency;
    logo: Logo;
    from: string;
    max_users: number;
    seats: number;
    max_projects: number;
    plan_id: number;
    plan_name: string;
    plan_code: string;
    next_charge: string;
    start_of_week: number;
    created_at: number;
    payment_mode: string;
    paid: boolean;
    company_size: string;
    owner_id: number;
    weekly_user_capacity: number;
    default_work_days: string;
    default_hour_rate: number;
    support_email: string;
    memory_retention_days: number;
    num_users: number;
    num_projects: number;
    active_projects_count: number;
    total_projects_count: number;
    capacity: Capacity;
    status: string;
    beta: boolean;
    expired: boolean;
    trial: boolean;
    days_to_end_trial: number;
    features: Feature[];
}

// Client
interface TimelyClient {
    id: number;
    name: string;
    color: string;
    active: boolean;
    external_id: string | null;
    updated_at: string;
    external_references?: unknown[];
}

// Project
interface TimelyProject {
    id: number;
    active: boolean;
    account_id: number;
    name: string;
    description: string;
    color: string;
    rate_type: string;
    billable: boolean;
    created_at: number;
    updated_at: number;
    external_id: string | null;
    budget_scope: string | null;
    client: TimelyClient | null;
    required_notes: boolean;
    required_labels: boolean;
    budget_expired_on: string | null;
    has_recurrence: boolean;
    enable_labels: string;
    default_labels: boolean;
    currency: Currency;
    team_ids: number[];
    budget: number;
    budget_type: string;
    budget_calculation: string;
    hour_rate: number;
    hour_rate_in_cents: number;
    budget_progress: number;
    budget_percent: number;
    invoice_by_budget: boolean;
    labels: TimelyLabel[];
    label_ids: number[];
    required_label_ids: number[];
    default_label_ids: number[];
    created_from: string;
}

// Label
interface TimelyLabel {
    id: number;
    name: string;
    sequence: number;
    parent_id: number | null;
    emoji: string | null;
    children: TimelyLabel[];
}

// User (simplified for events)
interface TimelyUser {
    id: number;
    email: string;
    name: string;
    avatar: Avatar;
    updated_at: string;
}

// Duration
interface Duration {
    hours: number;
    minutes: number;
    seconds: number;
    formatted: string;
    total_hours: number;
    total_seconds: number;
    total_minutes: number;
}

// Cost
interface Cost {
    fractional: number;
    formatted: string;
    amount: number;
    currency_code: string;
}

// Event (Time Entry)
interface TimelyEvent {
    id: number;
    uid: string;
    user: TimelyUser;
    project: TimelyProject;
    duration: Duration;
    estimated_duration: Duration;
    cost: Cost;
    estimated_cost: Cost;
    day: string; // YYYY-MM-DD
    note: string;
    sequence: number;
    estimated: boolean;
    timer_state: string;
    timer_started_on: number;
    timer_stopped_on: number;
    label_ids: number[];
    user_ids: number[];
    updated_at: number;
    created_at: number;
    created_from: string;
    updated_from: string;
    billed: boolean;
    billable: boolean;
    to: string;
    from: string;
    deleted: boolean;
    hour_rate: number;
    hour_rate_in_cents: number;
    creator_id: number | null;
    updater_id: number | null;
    external_id: string | null;
    entry_ids: number[];
    suggestion_id: number | null;
    draft: boolean;
    manage: boolean;
    forecast_id: number | null;
    billed_at: string | null;
    locked_reason: string | null;
    locked: boolean;
    invoice_id: number | null;
    timestamps: unknown[];
    state: string | null;
    external_links: unknown[];
}

// Suggested Entry (from web endpoint)
interface SuggestedEntry {
    id: number;
    day: string;
    from: string;
    to: string;
    duration: Duration;
    note: string;
    project_id: number | null;
    label_ids: number[];
    spam: boolean;
    // Additional fields as discovered
}

// Create Event Input
interface CreateEventInput {
    day: string;
    hours: number;
    minutes: number;
    note?: string;
    project_id?: number;
    user_id?: number;
    from?: string;
    to?: string;
    estimated_hours?: number;
    estimated_minutes?: number;
    label_ids?: number[];
    external_id?: string;
}

// Bulk Event Response
interface BulkEventResponse {
    deleted_ids: number[];
    created_ids: number[];
    updated_ids: number[];
    errors: {
        create: unknown[];
        update: unknown[];
        delete: unknown[];
    };
    job: unknown | null;
}
```

### CLI Types (`types/cli.ts`)

```typescript
interface TimelyArgs {
    _: string[];
    help?: boolean;
    verbose?: boolean;
    format?: 'json' | 'table' | 'csv';
    account?: number;
    project?: number;
    since?: string;
    upto?: string;
    date?: string;
}
```

---

## Part 4: API Client (`api/client.ts`)

### Class: `TimelyApiClient`

```typescript
class TimelyApiClient {
    private baseUrl = 'https://api.timelyapp.com/1.1';
    private storage: Storage;

    constructor(storage: Storage)

    // Core HTTP methods
    private async request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        options?: RequestOptions
    ): Promise<T>

    // Auto-refresh token if expired
    private async getAccessToken(): Promise<string>
    private async refreshToken(): Promise<OAuth2Tokens>

    // Public API methods
    get<T>(path: string, params?: Record<string, string>): Promise<T>
    post<T>(path: string, body: unknown): Promise<T>
    put<T>(path: string, body: unknown): Promise<T>
    delete<T>(path: string): Promise<T>

    // Check if authenticated
    isAuthenticated(): Promise<boolean>
}
```

---

## Part 5: Commands

### `login` Command

```typescript
// Opens browser for OAuth2 flow
// Flow:
// 1. Check if OAuth app credentials exist in config
// 2. If not, prompt user to enter client_id and client_secret
// 3. Open browser to: https://api.timelyapp.com/1.1/oauth/authorize?response_type=code&redirect_uri=...&client_id=...
// 4. User authorizes and gets redirected with ?code=...
// 5. Prompt user to paste the code
// 6. Exchange code for tokens via POST /oauth/token
// 7. Save tokens to config

async function loginCommand(args: TimelyArgs): Promise<void>
```

### `logout` Command

```typescript
// Clears OAuth tokens from config
async function logoutCommand(args: TimelyArgs): Promise<void>
```

### `accounts` Command

```typescript
// Usage: tools timely accounts [--select]
//
// Lists all accounts and optionally lets user select a default
// Saves selected account to config

async function accountsCommand(args: TimelyArgs): Promise<void>
```

### `projects` Command

```typescript
// Usage: tools timely projects [--account <id>] [--select]
//
// Lists all projects for the selected/specified account
// Saves to config for future reference

async function projectsCommand(args: TimelyArgs): Promise<void>
```

### `events` Command

```typescript
// Usage: tools timely events [--since YYYY-MM-DD] [--upto YYYY-MM-DD] [--day YYYY-MM-DD]
//
// Lists events for the current user within the date range

async function eventsCommand(args: TimelyArgs): Promise<void>
```

### `export-month` Command

```typescript
// Usage: tools timely export-month <YYYY-MM>
//
// Exports all time entries for a given month
// Uses caching with TTL for suggested_entries
//
// Implementation:
// 1. Parse month (e.g., "2025-10") into date range
// 2. For each day in the month:
//    - Use storage.getFileOrPut() to fetch/cache suggested entries
// 3. Combine all entries
// 4. Output in requested format (JSON/CSV/table)

async function exportMonthCommand(args: TimelyArgs): Promise<void>

// Helper: Download suggested entries for a specific date
async function downloadSuggestedEntriesForDate(
    client: TimelyApiClient,
    accountId: number,
    date: string
): Promise<SuggestedEntry[]>
```

### `status` Command

```typescript
// Usage: tools timely status
//
// Shows current configuration status:
// - Logged in as (user email)
// - Selected account
// - Selected project
// - Token expiry

async function statusCommand(args: TimelyArgs): Promise<void>
```

### `cache` Command

```typescript
// Usage: tools timely cache [clear|list]
//
// Manages the cache directory

async function cacheCommand(args: TimelyArgs): Promise<void>
```

---

## Part 6: Main Entry Point (`index.ts`)

```typescript
#!/usr/bin/env bun

import minimist from 'minimist';
import Enquirer from 'enquirer';
import chalk from 'chalk';
import logger from '../logger';
import { Storage } from '../utils/storage/storage';
import { TimelyApiClient } from './api/client';

// Command imports
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { accountsCommand } from './commands/accounts';
import { projectsCommand } from './commands/projects';
import { eventsCommand } from './commands/events';
import { exportMonthCommand } from './commands/export-month';
import { statusCommand } from './commands/status';
import { cacheCommand } from './commands/cache';

const COMMANDS = {
    login: loginCommand,
    logout: logoutCommand,
    accounts: accountsCommand,
    projects: projectsCommand,
    events: eventsCommand,
    'export-month': exportMonthCommand,
    status: statusCommand,
    cache: cacheCommand,
} as const;

function showHelp(): void {
    logger.info(`
Usage: tools timely <command> [options]

Commands:
  login                  Authenticate with Timely via OAuth2
  logout                 Clear stored authentication tokens
  accounts               List all accounts (--select to choose default)
  projects               List all projects (--select to choose default)
  events                 List time entries
  export-month <YYYY-MM> Export all entries for a month
  status                 Show current configuration
  cache [clear|list]     Manage cache

Global Options:
  -h, --help            Show this help message
  -v, --verbose         Enable verbose output
  --format <format>     Output format: json, table, csv (default: table)
  --account <id>        Override account ID
  --project <id>        Override project ID

Examples:
  tools timely login
  tools timely accounts --select
  tools timely projects
  tools timely export-month 2025-10
  tools timely events --since 2025-10-01 --upto 2025-10-31
`);
}

async function main(): Promise<void> {
    const args = minimist<TimelyArgs>(process.argv.slice(2), {
        alias: {
            h: 'help',
            v: 'verbose',
            f: 'format',
            a: 'account',
            p: 'project',
        },
        boolean: ['help', 'verbose', 'select'],
        string: ['format', 'since', 'upto', 'day', 'date'],
    });

    if (args.help || args._.length === 0) {
        showHelp();
        process.exit(0);
    }

    const command = args._[0];

    if (!(command in COMMANDS)) {
        logger.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

    const storage = new Storage('timely');
    await storage.ensureDirs();

    const client = new TimelyApiClient(storage);

    try {
        await COMMANDS[command as keyof typeof COMMANDS](args, storage, client);
    } catch (error) {
        logger.error(`Command failed: ${error}`);
        process.exit(1);
    }
}

main();
```

---

## Part 7: Suggested Entries Endpoint (Web Scraping)

The `suggested_entries.json` endpoint is not part of the public API but can be accessed from the web app:

```
GET https://app.timelyapp.com/:account_id/suggested_entries.json?date=YYYY-MM-DD&spam=true
```

### Required Headers/Cookies
- Requires authenticated session (cookies from web login)
- The endpoint uses web session cookies, not OAuth tokens

### Alternative Approach
Since this endpoint requires web session cookies, we have two options:

1. **Use Events API**: Use the official `GET /1.1/:account_id/events` endpoint instead, which works with OAuth tokens
2. **Cookie-based Auth**: Store web session cookies separately and use them for this specific endpoint

**Recommendation**: Use the official Events API for reliable access.

---

## Part 8: Implementation Phases

### Phase 1: Storage Utility
1. Create `src/utils/storage/storage.ts`
2. Implement directory management
3. Implement config read/write
4. Implement cache with TTL support
5. Add unit tests (optional)

### Phase 2: Base Timely Infrastructure
1. Create directory structure
2. Define all TypeScript types
3. Implement API client with OAuth2 token handling
4. Create main entry point skeleton

### Phase 3: Authentication Commands
1. Implement `login` command with browser OAuth flow
2. Implement `logout` command
3. Implement `status` command

### Phase 4: Data Commands
1. Implement `accounts` command
2. Implement `projects` command
3. Implement `events` command

### Phase 5: Export Feature
1. Implement `export-month` command
2. Add caching for API responses
3. Support multiple output formats

### Phase 6: Polish
1. Add cache management command
2. Improve error handling
3. Add interactive prompts where useful
4. Documentation

---

## API Reference (Timely API v1.1)

### Base URL
```
https://api.timelyapp.com/1.1
```

### Authentication
All API requests require Bearer token:
```
Authorization: Bearer <access_token>
```

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /oauth/authorize | OAuth2 authorization |
| POST | /oauth/token | Exchange code for tokens |
| GET | /accounts | List all accounts |
| GET | /accounts/:id | Get single account |
| GET | /:account_id/projects | List projects |
| GET | /:account_id/projects/:id | Get single project |
| GET | /:account_id/events | List events |
| POST | /:account_id/events | Create event |
| GET | /:account_id/events/:id | Get single event |
| PUT | /:account_id/events/:id | Update event |
| DELETE | /:account_id/events/:id | Delete event |
| GET | /:account_id/users | List users |
| GET | /:account_id/clients | List clients |

### Common Query Parameters for Events
- `day` - Specific date (YYYY-MM-DD)
- `since` - Start date
- `upto` - End date
- `per_page` - Records per page (default: 100)
- `page` - Page number
- `sort` - Sort field (updated_at, id, day)
- `order` - Sort order (asc, desc)

---

## Future Commands (Potential Extensions)

- `tools timely timer start [--project <id>] [--note "..."]` - Start timer
- `tools timely timer stop` - Stop timer
- `tools timely log <hours> [--project <id>] [--note "..."]` - Quick log time
- `tools timely report <month>` - Generate time report
- `tools timely clients` - List clients
- `tools timely labels` - List labels
- `tools timely sync` - Sync local cache with server

# GitHub Notifications, Activity Feed, Browser Utility & Search Enhancement

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GitHub notifications browsing/triage, activity feed, shared browser utility, and search stars filter to GenesisTools.

**Architecture:** New `Browser` utility class for cross-platform URL opening with config persistence. Two new GitHub subcommands (`notifications`, `activity`) following existing commander pattern. Notifications uses dual Octokit endpoints: `listRepoNotificationsForAuthenticatedUser` (when `--repo` specified, per_page 100) or `listNotificationsForAuthenticatedUser` (global, per_page 50). Activity uses Events API. Search gets a `--stars` qualifier. All integrate into existing interactive menu.

**Tech Stack:** Bun runtime, TypeScript, Commander.js, Octokit v5, @inquirer/prompts, chalk

**Project notes:**
- No test suite exists — verify with `tsgo --noEmit` and manual CLI testing
- Use `Bun.spawn()` for process execution
- Storage API: `new Storage("toolName")` → `getConfigValue<T>(key)` / `setConfigValue(key, val)` → `~/.genesis-tools/<toolName>/config.json`
- All GitHub commands follow `registerXxxCommand(program)` pattern via `createXxxCommand()` returning a Commander `Command`
- Output formats: `"ai"` (markdown with line numbers), `"md"` (plain markdown), `"json"`

---

### Task 1: Browser Utility Class

**Files:**
- Create: `src/utils/browser.ts`

**Step 1: Create the Browser utility**

```typescript
// src/utils/browser.ts
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";

export type BrowserName = "brave" | "safari" | "chrome" | "firefox" | "edge" | "arc";

export interface OpenResult {
    url: string;
    success: boolean;
    error?: string;
}

export interface BrowserOpenOptions {
    /** Override the configured/default browser for this call */
    browser?: BrowserName;
    /** Delay in ms between batch opens (default: 300) */
    staggerMs?: number;
}

const MACOS_APPS: Record<BrowserName, string> = {
    brave: "Brave Browser",
    safari: "Safari",
    chrome: "Google Chrome",
    firefox: "Firefox",
    edge: "Microsoft Edge",
    arc: "Arc",
};

const LINUX_BINARIES: Partial<Record<BrowserName, string>> = {
    brave: "brave-browser",
    chrome: "google-chrome",
    firefox: "firefox",
    edge: "microsoft-edge",
};

export class Browser {
    private static storage = new Storage("genesis-tools");

    static readonly SUPPORTED: readonly BrowserName[] = [
        "brave", "safari", "chrome", "firefox", "edge", "arc",
    ] as const;

    static async getPreferred(): Promise<BrowserName | undefined> {
        return Browser.storage.getConfigValue<BrowserName>("browser");
    }

    static async setPreferred(browser: BrowserName | undefined): Promise<void> {
        if (browser === undefined) {
            const config = await Browser.storage.getConfig<Record<string, unknown>>();
            if (config && "browser" in config) {
                delete config.browser;
                await Browser.storage.setConfig(config);
            }
        } else {
            await Browser.storage.setConfigValue("browser", browser);
        }
        logger.debug(`Browser preference set to: ${browser ?? "system default"}`);
    }

    static async open(url: string, options?: BrowserOpenOptions): Promise<OpenResult> {
        const browser = options?.browser ?? (await Browser.getPreferred());
        const cmd = Browser.buildCommand(url, browser);

        try {
            const proc = Bun.spawn({ cmd, stdio: ["ignore", "ignore", "ignore"] });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                if (browser) {
                    logger.debug(`Browser "${browser}" failed (exit ${exitCode}), falling back to OS default`);
                    return Browser.open(url);
                }
                return { url, success: false, error: `exit code ${exitCode}` };
            }
            return { url, success: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (browser) {
                logger.debug(`Browser "${browser}" threw: ${message}, falling back to OS default`);
                return Browser.open(url);
            }
            return { url, success: false, error: message };
        }
    }

    static async openAll(urls: string[], options?: BrowserOpenOptions): Promise<OpenResult[]> {
        if (urls.length === 0) return [];
        const staggerMs = options?.staggerMs ?? 300;
        const results: OpenResult[] = [];

        for (let i = 0; i < urls.length; i++) {
            const result = await Browser.open(urls[i], options);
            results.push(result);
            if (i < urls.length - 1 && staggerMs > 0) {
                await Bun.sleep(staggerMs);
            }
        }
        return results;
    }

    private static buildCommand(url: string, browser?: BrowserName): string[] {
        const platform = process.platform;

        if (browser) {
            if (platform === "darwin") {
                return ["open", "-a", MACOS_APPS[browser], url];
            }
            if (platform === "linux") {
                const binary = LINUX_BINARIES[browser];
                if (binary) return [binary, url];
            }
        }

        // OS default fallback
        if (platform === "darwin") return ["open", url];
        if (platform === "linux") return ["xdg-open", url];
        if (platform === "win32") return ["cmd", "/c", "start", "", url];
        return ["xdg-open", url];
    }
}
```

**Step 2: Verify types compile**

Run: `tsgo --noEmit 2>&1 | rg "browser"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/utils/browser.ts
git commit -m "feat(utils): add Browser utility class with cross-platform support"
```

---

### Task 2: Refactor Timely Login to Use Browser Utility

**Files:**
- Modify: `src/timely/commands/login.ts` (lines ~79-88)

**Step 1: Replace hardcoded `open` call**

In `src/timely/commands/login.ts`, find the block:
```typescript
try {
    const proc = Bun.spawn({
        cmd: ["open", authUrl.toString()],
        stdio: ["ignore", "ignore", "ignore"],
    });
    await proc.exited;
} catch {
    // Ignore if open command fails
}
```

Replace with:
```typescript
import { Browser } from "@app/utils/browser";
// ...
await Browser.open(authUrl.toString());
```

Add the import at the top of the file alongside existing imports.

**Step 2: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "timely"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/timely/commands/login.ts
git commit -m "refactor(timely): use Browser utility for OAuth URL opening"
```

---

### Task 3: Extend URL Parser — `apiUrlToWebUrl()` and `parseDate("h")`

**Files:**
- Modify: `src/utils/github/url-parser.ts`

**Step 1: Add `apiUrlToWebUrl()` function**

Append to `src/utils/github/url-parser.ts`:

```typescript
/**
 * Convert a GitHub API URL to a web browser URL
 *
 * API: https://api.github.com/repos/owner/repo/issues/123 → https://github.com/owner/repo/issues/123
 * API: https://api.github.com/repos/owner/repo/pulls/456  → https://github.com/owner/repo/pull/456
 * API: https://api.github.com/repos/owner/repo/commits/sha → https://github.com/owner/repo/commit/sha
 * API: null → fallback to repo html_url
 */
export function apiUrlToWebUrl(
    apiUrl: string | null,
    repoHtmlUrl: string,
): string {
    if (!apiUrl) return repoHtmlUrl;

    const match = apiUrl.match(
        /api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls|releases|commits)\/(.+)/,
    );
    if (!match) return repoHtmlUrl;

    const [, repoPath, resource, identifier] = match;
    const base = `https://github.com/${repoPath}`;

    switch (resource) {
        case "issues":
            return `${base}/issues/${identifier}`;
        case "pulls":
            return `${base}/pull/${identifier}`; // plural→singular
        case "commits":
            return `${base}/commit/${identifier}`;
        case "releases":
            return `${base}/releases`;
        default:
            return repoHtmlUrl;
    }
}

/**
 * Extract issue/PR number from a GitHub API URL
 */
export function extractNumberFromApiUrl(apiUrl: string | null): number | null {
    if (!apiUrl) return null;
    const match = apiUrl.match(/\/(issues|pulls)\/(\d+)$/);
    return match ? parseInt(match[2], 10) : null;
}
```

**Step 2: Extend `parseDate()` to support hours**

In `parseDate()`, change the regex from `(/^(\d+)([dwm])$/)` to include `h`:

```typescript
export function parseDate(input: string): Date | null {
    // Relative format: Nh, Nd, Nw, Nm
    const relativeMatch = input.match(/^(\d+)([hdwm])$/);
    if (relativeMatch) {
        const [, amount, unit] = relativeMatch;
        const now = new Date();
        const value = parseInt(amount, 10);

        switch (unit) {
            case "h":
                now.setHours(now.getHours() - value);
                return now;
            case "d":
                now.setDate(now.getDate() - value);
                return now;
            case "w":
                now.setDate(now.getDate() - value * 7);
                return now;
            case "m":
                now.setMonth(now.getMonth() - value);
                return now;
        }
    }

    // ISO 8601 format
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
        return date;
    }

    return null;
}
```

**Step 3: Export new functions from index**

Check `src/utils/github/index.ts` — add `apiUrlToWebUrl` and `extractNumberFromApiUrl` to the re-exports if that file exists.

**Step 4: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "url-parser"`
Expected: No errors

**Step 5: Commit**

```bash
git add src/utils/github/url-parser.ts src/utils/github/index.ts
git commit -m "feat(github): add apiUrlToWebUrl, extend parseDate with hours"
```

---

### Task 4: Add Notification & Activity Types

**Files:**
- Modify: `src/github/types.ts`

**Step 1: Add notification types**

Append to `src/github/types.ts`:

```typescript
// ============================================
// Notification Types
// ============================================

export type NotificationReason =
    | "approval_requested"
    | "assign"
    | "author"
    | "ci_activity"
    | "comment"
    | "invitation"
    | "manual"
    | "member_feature_requested"
    | "mention"
    | "review_requested"
    | "security_alert"
    | "security_advisory_credit"
    | "state_change"
    | "subscribed"
    | "team_mention";

export type NotificationSubjectType =
    | "Issue"
    | "PullRequest"
    | "Release"
    | "Discussion"
    | "CheckSuite"
    | "Commit";

export interface GitHubNotification {
    id: string;
    unread: boolean;
    reason: NotificationReason;
    updated_at: string;
    last_read_at: string | null;
    subject: {
        title: string;
        url: string | null;
        latest_comment_url: string | null;
        type: NotificationSubjectType;
    };
    repository: {
        id: number;
        full_name: string;
        html_url: string;
        owner: { login: string };
        name: string;
    };
    url: string;
    subscription_url: string;
}

export interface NotificationItem {
    id: string;
    title: string;
    repo: string;
    reason: NotificationReason;
    type: NotificationSubjectType;
    unread: boolean;
    updatedAt: string;
    webUrl: string;
    number: number | null;
}

export interface NotificationsCommandOptions {
    reason?: string;
    repo?: string;
    titleMatch?: string;
    since?: string;
    author?: string;
    state?: "read" | "unread" | "all";
    participating?: boolean;
    type?: string;
    open?: boolean;
    markRead?: boolean;
    markDone?: boolean;
    limit?: number;
    format?: "ai" | "md" | "json";
    output?: string;
    verbose?: boolean;
}

// ============================================
// Activity Types
// ============================================

export interface GitHubEvent {
    id: string;
    type: string;
    actor: { login: string; display_login: string };
    repo: { name: string };
    payload: Record<string, unknown>;
    created_at: string;
    public: boolean;
}

export interface ActivityItem {
    id: string;
    type: string;
    actor: string;
    repo: string;
    summary: string;
    createdAt: string;
    url: string | null;
}

export interface ActivityCommandOptions {
    user?: string;
    received?: boolean;
    repo?: string;
    type?: string;
    since?: string;
    limit?: number;
    format?: "ai" | "md" | "json";
    output?: string;
    verbose?: boolean;
}
```

**Step 2: Add `stars` to SearchCommandOptions**

Find `SearchCommandOptions` in `src/github/types.ts` and add:
```typescript
stars?: number;
```

**Step 3: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "types"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/github/types.ts
git commit -m "feat(github): add notification, activity, and search stars types"
```

---

### Task 5: Add Output Formatters

**Files:**
- Modify: `src/github/lib/output.ts`

**Step 1: Add `formatNotifications()`**

Read `src/github/lib/output.ts` first to understand existing patterns (especially `formatSearchResults`). Then add:

```typescript
import type { NotificationItem, ActivityItem } from "@app/github/types";

export function formatNotifications(
    items: NotificationItem[],
    format: "ai" | "md" | "json",
): string {
    if (format === "json") return JSON.stringify(items, null, 2);

    const lines: string[] = [];
    lines.push(`# Notifications (${items.length})\n`);

    if (items.length === 0) {
        lines.push("No notifications found.");
        return lines.join("\n");
    }

    // Summary stats
    const unreadCount = items.filter(i => i.unread).length;
    const byReason = new Map<string, number>();
    for (const item of items) {
        byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    }
    lines.push(`**Unread:** ${unreadCount} / ${items.length}`);
    lines.push(`**Reasons:** ${[...byReason.entries()].map(([r, c]) => `${r} (${c})`).join(", ")}\n`);

    // Table
    lines.push("| # | State | Type | Title | Repo | Reason | Updated |");
    lines.push("|---|-------|------|-------|------|--------|---------|");

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const state = item.unread ? "●" : "○";
        const shortType = item.type === "PullRequest" ? "PR" : item.type;
        const num = item.number ? `#${item.number}` : "";
        const title = `[${item.title}](${item.webUrl}) ${num}`;
        const date = new Date(item.updatedAt).toLocaleDateString();
        lines.push(`| ${i + 1} | ${state} | ${shortType} | ${title} | ${item.repo} | ${item.reason} | ${date} |`);
    }

    return lines.join("\n");
}
```

**Step 2: Add `formatActivity()`**

```typescript
export function formatActivity(
    items: ActivityItem[],
    format: "ai" | "md" | "json",
): string {
    if (format === "json") return JSON.stringify(items, null, 2);

    const lines: string[] = [];
    lines.push(`# Activity Feed (${items.length})\n`);

    if (items.length === 0) {
        lines.push("No activity found.");
        return lines.join("\n");
    }

    lines.push("| # | Time | Actor | Type | Summary | Repo |");
    lines.push("|---|------|-------|------|---------|------|");

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const time = new Date(item.createdAt).toLocaleString();
        const summary = item.url ? `[${item.summary}](${item.url})` : item.summary;
        lines.push(`| ${i + 1} | ${time} | @${item.actor} | ${item.type} | ${summary} | ${item.repo} |`);
    }

    return lines.join("\n");
}
```

**Step 3: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "output"`
Expected: No errors

**Step 4: Commit**

```bash
git add src/github/lib/output.ts
git commit -m "feat(github): add notification and activity output formatters"
```

---

### Task 6: Search `--stars` Enhancement

**Files:**
- Modify: `src/github/commands/search.ts`

**Step 1: Add stars to `buildBaseQuery()`**

In `buildBaseQuery()` function (~line 39), after the `minReactions` block, add:

```typescript
if (options.stars !== undefined) {
    searchQuery += ` stars:>=${options.stars}`;
}
```

**Step 2: Add `--stars` CLI option**

In `createSearchCommand()` (~line 337), add after the `--min-comment-reactions` option:

```typescript
.option("--stars <n>", "Min star count on repository", parseInt)
```

**Step 3: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "search"`
Expected: No errors

**Step 4: Test manually**

Run: `tools github search "typescript testing" --stars 1000 --limit 5`
Expected: Results with repos having 1000+ stars

**Step 5: Commit**

```bash
git add src/github/commands/search.ts
git commit -m "feat(github): add --stars filter to search command"
```

---

### Task 7: Notifications Command

**Files:**
- Create: `src/github/commands/notifications.ts`

**Step 1: Create the notifications command**

This is the largest file. Key implementation details:

```typescript
// src/github/commands/notifications.ts
import { formatNotifications } from "@app/github/lib/output";
import type {
    GitHubNotification,
    NotificationItem,
    NotificationsCommandOptions,
    NotificationSubjectType,
} from "@app/github/types";
import logger from "@app/logger";
import { Browser } from "@app/utils/browser";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { apiUrlToWebUrl, extractNumberFromApiUrl, parseDate, parseRepo } from "@app/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";
```

**Fetch function — dual endpoint strategy:**

```typescript
async function fetchNotifications(options: {
    repo?: string;
    all?: boolean;
    participating?: boolean;
    since?: string;
    before?: string;
}): Promise<GitHubNotification[]> {
    const octokit = getOctokit();
    const notifications: GitHubNotification[] = [];
    let page = 1;
    const MAX_PAGES = 20;

    // Use repo-specific endpoint when --repo is provided (per_page 100, server-side filter)
    if (options.repo) {
        const parsed = parseRepo(options.repo);
        if (!parsed) throw new Error(`Invalid repo format: ${options.repo}`);

        while (page <= MAX_PAGES) {
            const { data } = await withRetry(
                () => octokit.rest.activity.listRepoNotificationsForAuthenticatedUser({
                    owner: parsed.owner,
                    repo: parsed.repo,
                    all: options.all ?? true,
                    participating: options.participating ?? false,
                    since: options.since,
                    before: options.before,
                    per_page: 100,
                    page,
                }),
                { label: `GET /repos/${options.repo}/notifications (page ${page})` },
            );
            notifications.push(...(data as GitHubNotification[]));
            if (data.length < 100) break;
            page++;
        }
    } else {
        // Global endpoint (per_page 50)
        while (page <= MAX_PAGES) {
            const { data } = await withRetry(
                () => octokit.rest.activity.listNotificationsForAuthenticatedUser({
                    all: options.all ?? true,
                    participating: options.participating ?? false,
                    since: options.since,
                    before: options.before,
                    per_page: 50,
                    page,
                }),
                { label: `GET /notifications (page ${page})` },
            );
            notifications.push(...(data as GitHubNotification[]));
            if (data.length < 50) break;
            page++;
        }
    }

    return notifications;
}
```

**Type filter map:**

```typescript
const TYPE_FILTER_MAP: Record<string, NotificationSubjectType[]> = {
    issue: ["Issue"],
    pr: ["PullRequest"],
    release: ["Release"],
    discussion: ["Discussion"],
    ci: ["CheckSuite"],
    commit: ["Commit"],
};
```

**Client-side filter function:**

```typescript
function applyFilters(
    notifications: GitHubNotification[],
    options: NotificationsCommandOptions,
): GitHubNotification[] {
    let filtered = notifications;

    if (options.reason) {
        const reasons = new Set(options.reason.split(",").map(r => r.trim()));
        filtered = filtered.filter(n => reasons.has(n.reason));
    }

    if (options.type) {
        const allowedTypes = new Set(
            options.type.split(",").flatMap(t => TYPE_FILTER_MAP[t.trim()] ?? []),
        );
        if (allowedTypes.size > 0) {
            filtered = filtered.filter(n => allowedTypes.has(n.subject.type));
        }
    }

    if (options.titleMatch) {
        const isRegex = options.titleMatch.startsWith("/") && options.titleMatch.endsWith("/");
        if (isRegex) {
            const regex = new RegExp(options.titleMatch.slice(1, -1), "i");
            filtered = filtered.filter(n => regex.test(n.subject.title));
        } else {
            const lower = options.titleMatch.toLowerCase();
            filtered = filtered.filter(n => n.subject.title.toLowerCase().includes(lower));
        }
    }

    if (options.state === "unread") {
        filtered = filtered.filter(n => n.unread);
    } else if (options.state === "read") {
        filtered = filtered.filter(n => !n.unread);
    }

    return filtered;
}
```

**Convert to display items:**

```typescript
function toNotificationItems(notifications: GitHubNotification[]): NotificationItem[] {
    return notifications.map(n => ({
        id: n.id,
        title: n.subject.title,
        repo: n.repository.full_name,
        reason: n.reason,
        type: n.subject.type,
        unread: n.unread,
        updatedAt: n.updated_at,
        webUrl: apiUrlToWebUrl(n.subject.url, n.repository.html_url),
        number: extractNumberFromApiUrl(n.subject.url),
    }));
}
```

**Main command function + mark-read/done support:**

```typescript
export async function notificationsCommand(
    options: NotificationsCommandOptions,
): Promise<NotificationItem[]> {
    if (options.verbose) setGlobalVerbose(true);

    // Parse --since to ISO 8601
    let sinceISO: string | undefined;
    if (options.since) {
        const date = parseDate(options.since);
        if (date) sinceISO = date.toISOString();
        else console.log(chalk.yellow(`Could not parse --since "${options.since}", ignoring`));
    }

    console.log(chalk.dim(`Fetching notifications...`));

    const raw = await fetchNotifications({
        repo: options.repo,
        all: options.state !== "unread",
        participating: options.participating,
        since: sinceISO,
    });

    verbose(options, `Fetched ${raw.length} raw notifications`);

    const filtered = applyFilters(raw, options);
    verbose(options, `After filters: ${filtered.length} notifications`);

    const limited = options.limit ? filtered.slice(0, options.limit) : filtered;
    const items = toNotificationItems(limited);

    // Mark as read
    if (options.markRead && filtered.length > 0) {
        const octokit = getOctokit();
        if (options.repo) {
            const parsed = parseRepo(options.repo)!;
            await withRetry(
                () => octokit.rest.activity.markRepoNotificationsAsRead({
                    owner: parsed.owner,
                    repo: parsed.repo,
                }),
                { label: `PUT /repos/${options.repo}/notifications` },
            );
        } else {
            await withRetry(
                () => octokit.rest.activity.markNotificationsAsRead({}),
                { label: "PUT /notifications" },
            );
        }
        console.log(chalk.green(`Marked ${filtered.length} notifications as read`));
    }

    // Open in browser
    if (options.open && items.length > 0) {
        const urls = items.map(i => i.webUrl);
        console.log(chalk.dim(`Opening ${urls.length} URLs in browser...`));
        const results = await Browser.openAll(urls);
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
            console.log(chalk.yellow(`Failed to open ${failed.length} URLs`));
        }
    }

    // Format output
    const format = options.format ?? "ai";
    const output = formatNotifications(items, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`Output written to ${options.output}`));
    } else {
        console.log(output);
    }

    return items;
}
```

**Commander registration:**

```typescript
export function createNotificationsCommand(): Command {
    const cmd = new Command("notifications")
        .description("List and manage GitHub notifications")
        .option("--reason <reasons>", "Filter by reason (comma-separated: mention, comment, review_requested, etc.)")
        .option("-r, --repo <owner/repo>", "Filter to specific repository (uses faster repo-specific API)")
        .option("--title-match <pattern>", "Filter by title (substring or /regex/)")
        .option("--since <duration|date>", 'Notifications since (e.g. "7d", "2h", "2025-01-01")')
        .option("--state <state>", "Filter: read|unread|all", "all")
        .option("--participating", "Only participating notifications")
        .option("--type <types>", "Filter by type (comma-separated: issue, pr, release, discussion)")
        .option("--open", "Open matching URLs in browser")
        .option("--mark-read", "Mark matching notifications as read")
        .option("-L, --limit <n>", "Max results", parseInt, 50)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (opts) => {
            try {
                await notificationsCommand(opts);
            } catch (error) {
                logger.error({ error }, "Notifications command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
```

**Step 2: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "notifications"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/github/commands/notifications.ts
git commit -m "feat(github): add notifications command with dual-endpoint strategy"
```

---

### Task 8: Activity Command

**Files:**
- Create: `src/github/commands/activity.ts`

**Step 1: Create the activity command**

```typescript
// src/github/commands/activity.ts
import { formatActivity } from "@app/github/lib/output";
import type { ActivityCommandOptions, ActivityItem, GitHubEvent } from "@app/github/types";
import logger from "@app/logger";
import { checkAuth, getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { parseDate } from "@app/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";
```

**Event type filter map:**

```typescript
const EVENT_TYPE_MAP: Record<string, string[]> = {
    push: ["PushEvent"],
    issue: ["IssuesEvent"],
    pr: ["PullRequestEvent"],
    comment: ["IssueCommentEvent", "PullRequestReviewCommentEvent"],
    review: ["PullRequestReviewEvent"],
    star: ["WatchEvent"],
    fork: ["ForkEvent"],
    release: ["ReleaseEvent"],
    create: ["CreateEvent"],
    delete: ["DeleteEvent"],
};
```

**Event summarizer:**

```typescript
function summarizeEvent(event: GitHubEvent): ActivityItem {
    const payload = event.payload;
    let summary = "";
    let url: string | null = null;

    switch (event.type) {
        case "PushEvent": {
            const commits = (payload.commits as Array<unknown>)?.length ?? 0;
            const branch = (payload.ref as string)?.replace("refs/heads/", "") ?? "unknown";
            summary = `Pushed ${commits} commit(s) to ${branch}`;
            url = commits > 0 ? `https://github.com/${event.repo.name}/commit/${payload.head as string}` : null;
            break;
        }
        case "IssueCommentEvent": {
            const issue = payload.issue as Record<string, unknown>;
            summary = `Commented on #${issue?.number}: ${issue?.title}`;
            url = (payload.comment as Record<string, unknown>)?.html_url as string;
            break;
        }
        case "IssuesEvent": {
            const issue = payload.issue as Record<string, unknown>;
            summary = `${payload.action} issue #${issue?.number}: ${issue?.title}`;
            url = issue?.html_url as string;
            break;
        }
        case "PullRequestEvent": {
            const pr = payload.pull_request as Record<string, unknown>;
            summary = `${payload.action} PR #${pr?.number}: ${pr?.title}`;
            url = pr?.html_url as string;
            break;
        }
        case "PullRequestReviewEvent": {
            const pr = payload.pull_request as Record<string, unknown>;
            const review = payload.review as Record<string, unknown>;
            summary = `Reviewed PR #${pr?.number}: ${review?.state}`;
            url = review?.html_url as string;
            break;
        }
        case "WatchEvent":
            summary = `Starred ${event.repo.name}`;
            url = `https://github.com/${event.repo.name}`;
            break;
        case "ForkEvent":
            summary = `Forked ${event.repo.name}`;
            url = (payload.forkee as Record<string, unknown>)?.html_url as string;
            break;
        case "CreateEvent":
            summary = `Created ${payload.ref_type} ${(payload.ref as string) ?? ""} in ${event.repo.name}`;
            url = `https://github.com/${event.repo.name}`;
            break;
        case "DeleteEvent":
            summary = `Deleted ${payload.ref_type} ${(payload.ref as string) ?? ""}`;
            url = `https://github.com/${event.repo.name}`;
            break;
        case "ReleaseEvent": {
            const release = payload.release as Record<string, unknown>;
            summary = `${payload.action} release ${release?.tag_name}: ${release?.name}`;
            url = release?.html_url as string;
            break;
        }
        case "PullRequestReviewCommentEvent": {
            const pr = payload.pull_request as Record<string, unknown>;
            summary = `Commented on PR #${pr?.number} review`;
            url = (payload.comment as Record<string, unknown>)?.html_url as string;
            break;
        }
        default:
            summary = `${event.type.replace("Event", "")} on ${event.repo.name}`;
            break;
    }

    return {
        id: event.id,
        type: event.type.replace("Event", ""),
        actor: event.actor.display_login || event.actor.login,
        repo: event.repo.name,
        summary,
        createdAt: event.created_at,
        url,
    };
}
```

**Fetch + filter + main command function:**

```typescript
async function fetchEvents(username: string, options: {
    received?: boolean;
    perPage?: number;
    maxPages?: number;
}): Promise<GitHubEvent[]> {
    const octokit = getOctokit();
    const events: GitHubEvent[] = [];
    let page = 1;
    const maxPages = options.maxPages ?? 10;
    const perPage = options.perPage ?? 30;

    while (page <= maxPages) {
        const endpoint = options.received
            ? "GET /users/{username}/received_events"
            : "GET /users/{username}/events";

        const { data } = await withRetry(
            () => octokit.request(endpoint, { username, per_page: perPage, page }),
            { label: `${endpoint} (page ${page})` },
        );

        events.push(...(data as GitHubEvent[]));
        if ((data as GitHubEvent[]).length < perPage) break;
        page++;
    }

    return events;
}

export async function activityCommand(options: ActivityCommandOptions): Promise<void> {
    if (options.verbose) setGlobalVerbose(true);

    // Determine username
    let username = options.user;
    if (!username) {
        const auth = await checkAuth();
        if (!auth.authenticated || !auth.user) {
            console.error(chalk.red("Not authenticated. Provide --user or authenticate with gh."));
            process.exit(1);
        }
        username = auth.user;
    }

    console.log(chalk.dim(`Fetching activity for @${username}...`));

    let events = await fetchEvents(username, { received: options.received });
    verbose(options, `Fetched ${events.length} events`);

    // Filter by repo
    if (options.repo) {
        events = events.filter(e => e.repo.name === options.repo);
    }

    // Filter by type
    if (options.type) {
        const allowedTypes = new Set(
            options.type.split(",").flatMap(t => EVENT_TYPE_MAP[t.trim()] ?? []),
        );
        if (allowedTypes.size > 0) {
            events = events.filter(e => allowedTypes.has(e.type));
        }
    }

    // Filter by since
    if (options.since) {
        const sinceDate = parseDate(options.since);
        if (sinceDate) {
            events = events.filter(e => new Date(e.created_at) >= sinceDate);
        }
    }

    // Limit
    const limited = events.slice(0, options.limit ?? 30);

    // Summarize
    const items = limited.map(summarizeEvent);

    // Format
    const format = options.format ?? "ai";
    const output = formatActivity(items, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`Output written to ${options.output}`));
    } else {
        console.log(output);
    }
}

export function createActivityCommand(): Command {
    const cmd = new Command("activity")
        .description("Show GitHub activity feed")
        .option("--user <username>", "GitHub username (default: authenticated user)")
        .option("--received", "Show received events (others' activity affecting you)")
        .option("-r, --repo <owner/repo>", "Filter to specific repository")
        .option("--type <types>", "Event types (comma-separated: push, issue, pr, comment, review, star, fork, release)")
        .option("--since <duration|date>", 'Events since (e.g. "7d", "2025-01-01")')
        .option("-L, --limit <n>", "Max results", parseInt, 30)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (opts) => {
            try {
                await activityCommand(opts);
            } catch (error) {
                logger.error({ error }, "Activity command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
```

**Step 2: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "activity"`
Expected: No errors

**Step 3: Commit**

```bash
git add src/github/commands/activity.ts
git commit -m "feat(github): add activity feed command"
```

---

### Task 9: Register Commands + Interactive Menu

**Files:**
- Modify: `src/github/index.ts`

**Step 1: Add imports**

At the top of `src/github/index.ts`, add:

```typescript
import { createNotificationsCommand, notificationsCommand } from "@app/github/commands/notifications";
import { createActivityCommand, activityCommand } from "@app/github/commands/activity";
```

Also add `checkbox` to the `@inquirer/prompts` import:

```typescript
import { checkbox, confirm, input, select } from "@inquirer/prompts";
```

**Step 2: Register subcommands**

After the existing `program.addCommand(createReviewCommand())` line (~line 31), add:

```typescript
program.addCommand(createNotificationsCommand());
program.addCommand(createActivityCommand());
```

**Step 3: Add interactive menu entries**

In the `choices` array of the interactive `select` (~line 89), add before the `status` entry:

```typescript
{ value: "notifications", name: "🔔 Notifications" },
{ value: "activity", name: "📊 Activity Feed" },
```

**Step 4: Add interactive handlers**

After the existing `if (action === "get") { ... }` block and before the `// Issue, PR, or Comments` section, add:

```typescript
if (action === "notifications") {
    const stateFilter = await select({
        message: "Show notifications:",
        choices: [
            { value: "all", name: "All" },
            { value: "unread", name: "Unread only" },
            { value: "read", name: "Read only" },
        ],
    });

    const sinceFilter = await select({
        message: "Time range:",
        choices: [
            { value: undefined, name: "All time" },
            { value: "1d", name: "Last 24 hours" },
            { value: "7d", name: "Last 7 days" },
            { value: "30d", name: "Last 30 days" },
        ],
    });

    const repoFilter = await input({
        message: "Filter by repo (owner/repo, or empty for all):",
    });

    const items = await notificationsCommand({
        state: stateFilter as "read" | "unread" | "all",
        since: sinceFilter ?? undefined,
        repo: repoFilter.trim() || undefined,
        format: "ai",
    });

    if (items.length > 0) {
        const selected = await checkbox({
            message: "Select notifications to open in browser:",
            choices: items.map((item) => ({
                value: item.webUrl,
                name: `${item.unread ? "●" : "○"} [${item.type === "PullRequest" ? "PR" : item.type}] ${item.title} (${item.repo})`,
            })),
        });

        if (selected.length > 0) {
            await Browser.openAll(selected);
            console.log(chalk.green(`Opened ${selected.length} notification(s) in browser`));
        }
    }
    continue;
}

if (action === "activity") {
    const sinceFilter = await select({
        message: "Time range:",
        choices: [
            { value: "1d", name: "Last 24 hours" },
            { value: "7d", name: "Last 7 days" },
            { value: "30d", name: "Last 30 days" },
        ],
    });

    const typeFilter = await select({
        message: "Event type:",
        choices: [
            { value: undefined, name: "All" },
            { value: "push", name: "Pushes" },
            { value: "pr", name: "Pull Requests" },
            { value: "issue", name: "Issues" },
            { value: "comment", name: "Comments" },
        ],
    });

    await activityCommand({
        since: sinceFilter ?? undefined,
        type: typeFilter ?? undefined,
        format: "ai",
    });
    continue;
}
```

Also add the `Browser` import at the top:
```typescript
import { Browser } from "@app/utils/browser";
```

**Step 5: Verify compilation**

Run: `tsgo --noEmit 2>&1 | rg "index"`
Expected: No errors

**Step 6: Test interactive mode**

Run: `tools github`
Expected: Menu shows "Notifications" and "Activity Feed" entries

**Step 7: Commit**

```bash
git add src/github/index.ts
git commit -m "feat(github): register notifications & activity commands, add interactive menu"
```

---

### Task 10: Update GitHub Skill

**Files:**
- Modify: `plugins/genesis-tools/skills/github/SKILL.md`

**Step 1: Read current skill file**

Read `plugins/genesis-tools/skills/github/SKILL.md` to understand existing structure.

**Step 2: Add notification examples and documentation**

Add sections documenting:
- `tools github notifications` with all flags
- `tools github activity` with all flags
- `tools github search --stars` option
- Claude usage examples: "check my notifications from claude-code", "open unread mentions", "show activity for the past week", "find popular React libraries"

**Step 3: Commit**

```bash
git add plugins/genesis-tools/skills/github/SKILL.md
git commit -m "docs(github): update skill with notifications, activity, and stars docs"
```

---

## Verification Checklist

After all tasks are complete:

1. `tsgo --noEmit` — full project type check, no errors
2. `tools github notifications --since 7d` — fetches global notifications
3. `tools github notifications --repo anthropics/claude-code --reason mention --open` — repo-specific fetch + browser open
4. `tools github notifications --state unread --mark-read` — mark notifications read
5. `tools github activity --since 7d` — activity feed
6. `tools github activity --type push,pr --since 1d` — filtered activity
7. `tools github search "react" --stars 1000 --limit 5` — search with stars filter
8. `tools github` — interactive menu shows new entries, notifications flow works with checkbox selection
9. Browser config: run a quick test of `Browser.setPreferred("brave")` then `Browser.open("https://example.com")` to verify config persistence

---

## File Summary

| Action | File | Task |
|--------|------|------|
| CREATE | `src/utils/browser.ts` | 1 |
| MODIFY | `src/timely/commands/login.ts` | 2 |
| MODIFY | `src/utils/github/url-parser.ts` | 3 |
| MODIFY | `src/github/types.ts` | 4 |
| MODIFY | `src/github/lib/output.ts` | 5 |
| MODIFY | `src/github/commands/search.ts` | 6 |
| CREATE | `src/github/commands/notifications.ts` | 7 |
| CREATE | `src/github/commands/activity.ts` | 8 |
| MODIFY | `src/github/index.ts` | 9 |
| MODIFY | `plugins/genesis-tools/skills/github/SKILL.md` | 10 |

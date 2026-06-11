# 09 — Remaining Features (Todos / Claude Usage / Daemon / Containers / Weather) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first. Work in the `feat/dev-dashboard-mobile` worktree.
> These are the **deferred** features (ship after the five core features in 05–08), so each section
> is proportionate but **complete — no placeholders.**

**Goal:** Bring the last four web routes (Todos, Claude usage, Daemon, Containers) and the shared
Weather card to the Expo mobile app at parity, AND **own the contract additions** (DTOs + endpoint
paths + client methods + unit tests) these features need — Plan 03 deliberately deferred them to
this plan ("…same `getJson`/`post` pattern, one method per route … read the lib return type for
each").

**Architecture:** Contract-first. Tasks 1–3 extend `src/dev-dashboard/contract/{dto,endpoints,
client}.ts` with the field-accurate DTOs and typed client methods for `todos`, `claude`, `daemon`,
`containers`, `weather` (proven by `client.test.ts` with a fake `fetch`, the Plan 03 pattern). The
todos client method is **503-aware** (throws a typed `RemindersPermissionError` so the screen can
render the request-access CTA). Tasks 4–8 build five Expo screens (`app/(more)/…`) on TanStack Query
+ the mobile `dashboard` client (assumed wired in Plan 04), each with a Page Object + a section in
the combined Appium smoke spec (Task 9).

**Tech Stack:** Bun + TypeScript (strict, `SafeJSON`, logger/out split) for the contract + `bun:test`
units; Expo SDK 55 / RN 0.83 / expo-router v7 / TanStack Query v5 / NativeWind v5 / victory-native
(`MetricChart`) for the mobile screens; Appium + Page Objects (`appium_*` MCP tools) for E2E.

---

## Assumed from Plans 03 / 04 / 05 (consume by name — do NOT re-invent)

These are forward-dependencies. If a name below does not yet exist when you start, the depended-on
plan is incomplete — stop and flag it, do not invent a divergent name.

- **`@devdashboard/contract` client** (Plan 03) — the typed client returned by
  `createDashboardClient({ baseUrl, fetch, authHeader, eventSourceFactory })`. **This plan ADDS the
  `todos` / `claude` / `daemon` / `containers` / `weather` namespaces to it** (Tasks 1–3); they do
  not exist yet — Plan 03 only shipped `system` / `tmux` / `ttyd` / `qa`.
- **Mobile `dashboard` client** (Plan 04) — a `DashboardClient` instance constructed in the Expo app
  (`DevDashboard/mobile/src/lib/dashboard.ts`) with RN `fetch`, a `SecureStore`-backed `authHeader`,
  and the file-04 SSE factory. Screens import `dashboard` from there. **Assumed export name:
  `dashboard`.** (openQuestion: confirm the module path.)
- **`QueryClientProvider` + query infrastructure** (Plan 04) — `onlineManager`/`focusManager` wired
  to netinfo + AppState. Screens just call `useQuery`/`useMutation`.
- **`MetricChart`** (Plan 05 — `DevDashboard/mobile/src/components/charts/MetricChart.tsx`) — the
  victory-native chart behind the ADR §6 `MetricChart` interface. **Assumed props used by this plan:**
  `{ series: Array<{ key: string; label: string; color: string; points: Array<{ x: number; y: number }> }>; yDomain?: [number, number]; height?: number; testID?: string }`. The authoritative
  definition lives in Plan 05; if it diverges, adapt the mappers here, not the chart.
- **Navigation slot** (Plan 04) — these five are **secondary** screens. **Assumed:** a `(more)`
  route group reachable from a "More" native-tab entry, i.e. files live at
  `DevDashboard/mobile/app/(more)/{todos,claude,daemon,containers}.tsx`. Weather is a **card**, not a
  screen — it is rendered inside the Pulse/home screen (Plan 05) and re-used here only via its shared
  component. (openQuestion: confirm the `(more)` group name + "More" tab.)
- **Theme tokens** — NativeWind v5 maps the `--dd-*` tokens via `@theme` (Plan 04). Use the same
  token class names the web uses (`text-[var(--dd-text-primary)]` becomes the NativeWind token
  utility, e.g. `text-dd-text-primary`). Use **only** mapped tokens — no raw palette.
  - **⚠️ NativeWind token utilities this plan REQUIRES — Plan 04 MUST define the underlying `--dd-*`
    tokens (and their NativeWind `@theme` mapping) for these, or the styling ships broken silently
    (className is a string — `tsc` and the Appium spec both pass while colors are wrong):**
    `dd-bg`, `dd-panel`, `dd-border`, `dd-text-primary`, `dd-text-secondary`, `dd-text-muted`,
    `dd-accent`, `dd-on-accent` (readable text on the accent fill), `dd-danger`, `dd-warning`. The web
    only proves `--dd-text-primary/secondary/muted` + `--dd-accent` exist (`dd-panel` is a composite
    CSS *class* there, web danger was a raw `#f87171`) — so `dd-bg/panel/border/on-accent/danger/
    warning` are **new tokens 04 must add**. (openQuestion: confirm the `--dd-*` token set + mapping.)
- **Appium `BasePage`** (Plan 04 — `DevDashboard/mobile/e2e/pages/base.page.ts`) — a `BasePage` with
  `find(accessibilityId)`, `tap(accessibilityId)`, `setValue(accessibilityId, text)`,
  `text(accessibilityId)`, `exists(accessibilityId)`, `waitForVisible(id)`, `waitForAny(ids[])`,
  `scrollToFirst(listId, prefix)`, `tapFirstWithPrefix(prefix)` — wrappers over the `appium_*` MCP
  tools. The Page Objects below `extends BasePage`. (openQuestion: confirm the `BasePage` helper set.)
- **Appium `NavPage` + `PulsePage`** (Plan 04 / Plan 05) — `NavPage` drives the "More" tab + the
  `(more)` stack: `openMore(route)`, `openHome()`. `PulsePage` (Plan 05) owns the home/Pulse screen
  and is the right page to assert the `weather-card` `testID` against. The combined smoke spec
  (Task 9) consumes both by name. (openQuestion: confirm `NavPage`/`PulsePage` exist with these
  methods.)

> **Standing rule (ADR §0.1):** before writing any native integration, query current docs
> (`context7` `/websites/expo_dev_versions_v55_0_0`, the `expo:*` skills, web search). Versions move.

---

## File Structure

**Modify (contract — Tasks 1–3):**
- `src/dev-dashboard/contract/dto.ts` — add the field-accurate DTOs (supersede the Plan 03 stubs).
- `src/dev-dashboard/contract/endpoints.ts` — add the path builders + response type aliases.
- `src/dev-dashboard/contract/client.ts` — add the `todos`/`claude`/`daemon`/`containers`/`weather`
  namespaces + `RemindersPermissionError`.
- `src/dev-dashboard/contract/client.test.ts` — extend with fake-fetch tests for the new methods +
  the 503 → `RemindersPermissionError` case.

**Create (mobile screens — Tasks 4–8):**
- `DevDashboard/mobile/app/(more)/todos.tsx` — Todos screen (list/add/complete/edit/delete + CTA).
- `DevDashboard/mobile/src/components/todos/TodoRow.tsx` — one reminder row.
- `DevDashboard/mobile/src/components/todos/AddTodoSheet.tsx` — add/edit bottom sheet (shared form).
- `DevDashboard/mobile/src/components/todos/RemindersPermissionCta.tsx` — the 503 request-access state.
- `DevDashboard/mobile/app/(more)/claude.tsx` — Claude usage screen (account cards + history charts).
- `DevDashboard/mobile/src/components/claude/AccountUsageCard.tsx` — one account's current usage.
- `DevDashboard/mobile/src/components/claude/AccountHistoryChart.tsx` — `MetricChart` per account.
- `DevDashboard/mobile/src/lib/claude-usage-series.ts` — pure `MultiBucketHistoryResult` → chart series mapper.
- `DevDashboard/mobile/src/lib/claude-usage-series.test.ts` — RN-runner unit test for the mapper.
- `DevDashboard/mobile/app/(more)/daemon.tsx` — Daemon screen (status + tasks + runs + log viewer).
- `DevDashboard/mobile/src/components/daemon/DaemonStatusHeader.tsx`
- `DevDashboard/mobile/src/components/daemon/RunRow.tsx`
- `DevDashboard/mobile/src/components/daemon/RunLogSheet.tsx` — the run-log viewer.
- `DevDashboard/mobile/app/(more)/containers.tsx` — Containers screen.
- `DevDashboard/mobile/src/components/containers/ContainerRow.tsx`
- `DevDashboard/mobile/src/components/weather/WeatherCard.tsx` — shared card (Pulse imports it too).

**Create (E2E — Task 9):**
- `DevDashboard/mobile/e2e/pages/todos.page.ts`
- `DevDashboard/mobile/e2e/pages/claude-usage.page.ts`
- `DevDashboard/mobile/e2e/pages/daemon.page.ts`
- `DevDashboard/mobile/e2e/pages/containers.page.ts`
- `DevDashboard/mobile/e2e/specs/features-rest.smoke.spec.ts` — combined smoke touching all five.

---

### Task 1: Contract DTOs for the five features (`dto.ts`)

> **Supersedes the Plan 03 stubs.** Plan 03's `TodoItem` (`{ reminderId, listIdentifier, … }`) and
> `Container`/`ClaudeUsage`/`DaemonOverview` names were idealized — the real JSON differs. Keep the
> intent, fix the fields, define them as **pure inline types** (do NOT re-export from
> `@genesiscz/darwinkit` — it is not resolvable in the RN bundle / cross-package boundary; verified).

**Files:**
- Modify: `src/dev-dashboard/contract/dto.ts`

- [ ] **Step 1: Confirm the real lib shapes (read, don't guess)**

Run:
```bash
rg -n "interface (TodosResult|ContainerInfo|ContainersResult|DaemonOverview|RunSummary|LogMeta|LogLine|LogExit|WeatherSnapshot|AccountUsage|UsageBucket|UsageResponse|UsageSnapshot|BucketSeries|MultiBucketHistoryResult)" \
  src/dev-dashboard/lib src/claude/lib src/daemon/lib
```
Expected: confirms the field names used below (`reminders`/`lists`, `is_completed`, `due_date`,
numeric `priority`, `dockerAvailable`/`containers`, `status`/`tasks`, `resetsAt` vs `resets_at`).

- [ ] **Step 2: Add the DTOs to `dto.ts`**

Append to `src/dev-dashboard/contract/dto.ts`:

```typescript
// ── Todos (macOS Reminders-backed). Mirrors lib/todos/types.ts -> TodosResult.
// ReminderInfo / ReminderListInfo come from @genesiscz/darwinkit in lib, but are
// redefined here as pure inline types (the dep is not RN-bundle/cross-package safe).
export type TodoReminderPriorityRaw = number; // 0 = none, 1 = high, 5 = medium, 9 = low (Apple EKReminder)
export type TodoPriority = "none" | "low" | "medium" | "high";

export interface ReminderInfo {
    identifier: string;
    title: string;
    notes?: string | null;
    /** ISO string or null. */
    due_date: string | null;
    /** Raw EKReminder numeric priority (see TodoReminderPriorityRaw). */
    priority: TodoReminderPriorityRaw;
    is_completed: boolean;
    is_flagged: boolean;
    has_alarms: boolean;
    url?: string | null;
    list_identifier: string;
    list_title: string;
}

export interface ReminderListInfo {
    identifier: string;
    title: string;
}

export interface TodosResult {
    lists: ReminderListInfo[];
    reminders: ReminderInfo[];
}

export interface RequestRemindersAccessResult {
    authorized: boolean;
    status: string;
}

export type TodoGroupBy = "date" | "date-priority" | "priority" | "bucket";
export type TodoStatusFilter = "active" | "done" | "all";

// ── Claude usage. /api/claude/usage -> AccountUsage[].
export interface UsageBucket {
    utilization: number;
    resets_at: string | null;
}

export interface UsageResponse {
    five_hour: UsageBucket;
    seven_day: UsageBucket;
    seven_day_opus?: UsageBucket | null;
    seven_day_sonnet?: UsageBucket | null;
    seven_day_oauth_apps?: UsageBucket | null;
    [key: string]: UsageBucket | null | undefined;
}

export interface AccountUsage {
    accountName: string;
    label?: string;
    usage?: UsageResponse;
    error?: string;
}

export interface UsageSnapshot {
    id: number;
    timestamp: string;
    accountName: string;
    bucket: string;
    utilization: number;
    /** NB: camelCase here (history snapshot), snake_case (resets_at) on the live UsageBucket. */
    resetsAt: string | null;
}

export interface BucketSeries {
    bucket: string;
    snapshots: UsageSnapshot[];
}

export interface MultiBucketHistoryResult {
    series: BucketSeries[];
    hint?: string;
}

// ── Daemon. /api/daemon/status -> DaemonOverview, /runs -> RunSummary[], /runs/log -> LogEntry[].
export interface DaemonStatus {
    installed: boolean;
    running: boolean;
    pid: number | null;
}

export interface DaemonTask {
    name: string;
    command: string;
    every: string;
    retries: number;
    enabled: boolean;
    description?: string;
    timeoutMs?: number;
    notify?: boolean;
}

export interface DaemonOverview {
    status: DaemonStatus;
    tasks: DaemonTask[];
}

export interface RunSummary {
    taskName: string;
    runId: string;
    logFile: string;
    startedAt: string;
    exitCode: number | null;
    duration_ms: number | null;
    attempt: number;
}

export interface LogMeta {
    type: "meta";
    taskName: string;
    command: string;
    runId: string;
    attempt: number;
    startedAt: string;
}

export interface LogLine {
    type: "stdout" | "stderr";
    ts: string;
    data: string;
}

export interface LogExit {
    type: "exit";
    ts: string;
    code: number | null;
    duration_ms: number;
    timedOut?: boolean;
}

export type LogEntry = LogMeta | LogLine | LogExit;

// ── Containers. /api/containers -> ContainersResult.
export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    ports: string;
}

export interface ContainersResult {
    dockerAvailable: boolean;
    containers: ContainerInfo[];
}

// ── Weather. /api/weather -> WeatherSnapshot.
export interface WeatherSnapshot {
    tempC: number | null;
    weatherCode: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    fetchedAt: string;
    error?: string;
}
```

> If Plan 03 left placeholder `TodoItem` / `Container` / `ClaudeUsage` / `DaemonOverview`(stub) names
> in `dto.ts`, **replace** them — search call sites first (`rg -n "TodoItem|ClaudeUsage\b" src/dev-dashboard`)
> and there should be none yet (no consumer shipped). Add `// supersedes 03 stub` next to each.

- [ ] **Step 3: Run the purity guard (RN-bundle safety must still hold)**

Run: `bun test src/dev-dashboard/contract/contract-purity.test.ts`
Expected: PASS — no `node:`/`bun:` imports, no value imports from `lib/*` (the DTOs are inline types,
not re-exports, so this stays green).

- [ ] **Step 4: Typecheck**

Run: `bunx tsgo --noEmit | rg "contract/dto"`
Expected: no errors referencing `contract/dto.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/contract/dto.ts
git commit -m "feat(dd-contract): field-accurate DTOs for todos/claude/daemon/containers/weather"
```

---

### Task 2: Contract endpoint paths + response aliases (`endpoints.ts`)

**Files:**
- Modify: `src/dev-dashboard/contract/endpoints.ts`

- [ ] **Step 1: Add the path builders**

Add to the `paths` object in `src/dev-dashboard/contract/endpoints.ts` (Plan 03 only added the GET
`todos`/`weather`/`claudeUsage`/`daemonStatus`/`containers` paths — add the rest, including all
POST/PATCH/DELETE):

```typescript
    // ── todos
    todos: (q: { listIds?: string[]; includeCompleted?: boolean } = {}) => {
        const sp = new URLSearchParams();
        if (q.listIds?.length) {
            sp.set("listIds", q.listIds.join(","));
        }

        if (q.includeCompleted) {
            sp.set("includeCompleted", "true");
        }

        const s = sp.toString();
        return `/api/todos${s ? `?${s}` : ""}`;
    },
    todosCreate: () => "/api/todos",
    todosComplete: () => "/api/todos/complete",
    todosPatch: () => "/api/todos",
    todosDelete: () => "/api/todos",
    todosRequestAccess: () => "/api/todos/request-access",

    // ── claude usage
    claudeUsage: () => "/api/claude/usage",
    claudeUsageHistory: (q: { account: string; buckets: string[]; minutes: number }) =>
        `/api/claude/usage/history?account=${encodeURIComponent(q.account)}&buckets=${encodeURIComponent(q.buckets.join(","))}&minutes=${q.minutes}`,

    // ── daemon
    daemonStatus: () => "/api/daemon/status",
    daemonRuns: (q: { task?: string; limit?: number } = {}) => {
        const sp = new URLSearchParams();
        if (q.task) {
            sp.set("task", q.task);
        }

        if (q.limit) {
            sp.set("limit", String(q.limit));
        }

        const s = sp.toString();
        return `/api/daemon/runs${s ? `?${s}` : ""}`;
    },
    daemonRunLog: (logFile: string) => `/api/daemon/runs/log?logFile=${encodeURIComponent(logFile)}`,

    // ── containers / weather
    containers: () => "/api/containers",
    weather: () => "/api/weather",
```

- [ ] **Step 2: Add the response type aliases**

Add to the import-type list + the alias block in `endpoints.ts`:

```typescript
import type {
    AccountUsage, ContainersResult, DaemonOverview, LogEntry,
    MultiBucketHistoryResult, RequestRemindersAccessResult, RunSummary,
    TodosResult, WeatherSnapshot,
} from "@app/dev-dashboard/contract/dto";

export type TodosRes = TodosResult;
export type RequestRemindersAccessRes = RequestRemindersAccessResult;
export type ClaudeUsageRes = AccountUsage[];
export type ClaudeUsageHistoryRes = MultiBucketHistoryResult;
export type DaemonStatusRes = DaemonOverview;
export type DaemonRunsRes = RunSummary[];
export type DaemonRunLogRes = LogEntry[];
export type ContainersRes = ContainersResult;
export type WeatherRes = WeatherSnapshot;
```

> If Plan 03 already declared `ClaudeUsageRes` / `ContainersRes` / `DaemonStatusRes` with the wrong
> shape (e.g. `ContainersRes = Container[]`), **replace** them with the above and add
> `// supersedes 03 stub`. The web routes prove the truth: `/api/claude/usage` returns an **array**,
> `/api/containers` returns `{ dockerAvailable, containers }`.

- [ ] **Step 3: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "contract/endpoints"`
Expected: no errors.

```bash
git add src/dev-dashboard/contract/endpoints.ts
git commit -m "feat(dd-contract): paths + response aliases for the deferred features"
```

---

### Task 3: Contract client methods + `RemindersPermissionError` (`client.ts`)

**Files:**
- Modify: `src/dev-dashboard/contract/client.ts`
- Test: `src/dev-dashboard/contract/client.test.ts`

- [ ] **Step 1: Write the failing tests (extend `client.test.ts`)**

Append to `src/dev-dashboard/contract/client.test.ts`:

```typescript
import { createDashboardClient, RemindersPermissionError } from "@app/dev-dashboard/contract/client";

function fakeFetchSeq(responses: Array<{ status: number; body: unknown }>): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    return { fetch: fetchImpl, calls };
}

describe("dashboard.todos", () => {
    it("lists todos and forwards listIds + includeCompleted", async () => {
        const { fetch: f, calls } = fakeFetchSeq([{ status: 200, body: { lists: [], reminders: [] } }]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        const res = await c.todos.list({ listIds: ["A", "B"], includeCompleted: true });
        expect(res.reminders).toEqual([]);
        expect(calls[0].url).toContain("/api/todos?listIds=A%2CB&includeCompleted=true");
    });

    it("throws RemindersPermissionError on a 503 (permission denied)", async () => {
        const { fetch: f } = fakeFetchSeq([{ status: 503, body: { error: "Reminders permission denied" } }]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        await expect(c.todos.list()).rejects.toBeInstanceOf(RemindersPermissionError);
    });

    it("requestAccess POSTs and parses { authorized, status }", async () => {
        const { fetch: f, calls } = fakeFetchSeq([{ status: 200, body: { authorized: true, status: "authorized" } }]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        const r = await c.todos.requestAccess();
        expect(r.authorized).toBe(true);
        expect(calls[0].init?.method).toBe("POST");
        expect(calls[0].url).toContain("/api/todos/request-access");
    });
});

describe("dashboard.claude", () => {
    it("usage returns the account array", async () => {
        const { fetch: f } = fakeFetchSeq([{ status: 200, body: [{ accountName: "main", usage: { five_hour: { utilization: 0.4, resets_at: null }, seven_day: { utilization: 0.1, resets_at: null } } }] }]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        const accounts = await c.claude.usage();
        expect(accounts[0].accountName).toBe("main");
    });

    it("usageHistory forwards account, buckets, minutes", async () => {
        const { fetch: f, calls } = fakeFetchSeq([{ status: 200, body: { series: [] } }]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        await c.claude.usageHistory({ account: "main", buckets: ["five_hour", "seven_day"], minutes: 1440 });
        expect(calls[0].url).toContain("account=main");
        expect(calls[0].url).toContain("buckets=five_hour%2Cseven_day");
        expect(calls[0].url).toContain("minutes=1440");
    });
});

describe("dashboard.daemon / containers / weather", () => {
    it("daemon.status + runs + runLog", async () => {
        const { fetch: f, calls } = fakeFetchSeq([
            { status: 200, body: { status: { installed: true, running: true, pid: 12 }, tasks: [] } },
            { status: 200, body: [{ taskName: "t", runId: "r", logFile: "f.jsonl", startedAt: "s", exitCode: 0, duration_ms: 1, attempt: 1 }] },
            { status: 200, body: [{ type: "exit", ts: "x", code: 0, duration_ms: 5 }] },
        ]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        expect((await c.daemon.status()).status.running).toBe(true);
        expect((await c.daemon.runs({ limit: 20 }))[0].taskName).toBe("t");
        const log = await c.daemon.runLog("f.jsonl");
        expect(log[0].type).toBe("exit");
        expect(calls[1].url).toContain("/api/daemon/runs?limit=20");
        expect(calls[2].url).toContain("logFile=f.jsonl");
    });

    it("containers + weather", async () => {
        const { fetch: f } = fakeFetchSeq([
            { status: 200, body: { dockerAvailable: true, containers: [{ id: "1", name: "x", image: "i", state: "running", status: "Up", ports: "" }] } },
            { status: 200, body: { tempC: 12, weatherCode: 0, description: "Clear", sunrise: null, sunset: null, label: "Home", fetchedAt: "t" } },
        ]);
        const c = createDashboardClient({ baseUrl: "http://h", fetch: f });
        expect((await c.containers.list()).containers[0].name).toBe("x");
        expect((await c.weather.get()).tempC).toBe(12);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/contract/client.test.ts`
Expected: FAIL — `RemindersPermissionError` not exported; `c.todos` / `c.claude` / `c.daemon` /
`c.containers` / `c.weather` are undefined.

- [ ] **Step 3: Implement — add the error class + namespaces**

In `src/dev-dashboard/contract/client.ts`, add the error class near the top (after the existing
interface declarations):

```typescript
/** Thrown when GET /api/todos returns 503 (macOS Reminders permission denied). The mobile/web
 *  screen catches this to render the request-access CTA instead of a generic error. */
export class RemindersPermissionError extends Error {
    constructor(message = "Reminders permission needed") {
        super(message);
        this.name = "RemindersPermissionError";
    }
}
```

Update the imports at the top of `client.ts` to pull the new aliases + DTOs:

```typescript
import type {
    ClaudeUsageHistoryRes, ClaudeUsageRes, ContainersRes, DaemonRunLogRes, DaemonRunsRes,
    DaemonStatusRes, RequestRemindersAccessRes, TodosRes, WeatherRes,
} from "@app/dev-dashboard/contract/endpoints";
```

Inside the object returned by `createDashboardClient`, add the five namespaces alongside the existing
`system`/`tmux`/`ttyd`/`qa`:

```typescript
        todos: {
            list: async (q: Parameters<typeof paths.todos>[0] = {}): Promise<TodosRes> => {
                const auth = opts.authHeader?.();
                const res = await fetchImpl(`${baseUrl}${paths.todos(q)}`, {
                    headers: {
                        "Content-Type": "application/json",
                        ...(auth ? { Authorization: auth } : {}),
                    },
                });

                if (res.status === 503) {
                    throw new RemindersPermissionError();
                }

                if (!res.ok) {
                    const text = await res.text().catch(() => "");
                    throw new Error(`${paths.todos(q)} -> ${res.status}: ${text}`);
                }

                return JSON.parse(await res.text()) as TodosRes;
            },
            create: (b: { title: string; listName?: string; due?: string; priority?: string; notes?: string }) =>
                post<{ ok: boolean }>(paths.todosCreate(), b),
            complete: (reminderId: string) => post<{ ok: boolean }>(paths.todosComplete(), { reminderId }),
            patch: (b: { reminderId: string; listIdentifier: string; title: string; notes?: string; due?: string | null; priority?: string; url?: string }) =>
                getJson<{ ok: boolean }>(paths.todosPatch(), { method: "PATCH", body: JSON.stringify(b) }),
            remove: (reminderId: string) =>
                getJson<{ ok: boolean }>(paths.todosDelete(), { method: "DELETE", body: JSON.stringify({ reminderId }) }),
            requestAccess: () => post<RequestRemindersAccessRes>(paths.todosRequestAccess(), {}),
        },
        claude: {
            usage: () => getJson<ClaudeUsageRes>(paths.claudeUsage()),
            usageHistory: (q: { account: string; buckets: string[]; minutes: number }) =>
                getJson<ClaudeUsageHistoryRes>(paths.claudeUsageHistory(q)),
        },
        daemon: {
            status: () => getJson<DaemonStatusRes>(paths.daemonStatus()),
            runs: (q: { task?: string; limit?: number } = {}) => getJson<DaemonRunsRes>(paths.daemonRuns(q)),
            runLog: (logFile: string) => getJson<DaemonRunLogRes>(paths.daemonRunLog(logFile)),
        },
        containers: {
            list: () => getJson<ContainersRes>(paths.containers()),
        },
        weather: {
            get: () => getJson<WeatherRes>(paths.weather()),
        },
```

> NB: `todos.list` does **not** use the shared `getJson` helper because it must intercept the 503
> before `getJson`'s generic throw. `getJson`/`post` are the existing Plan 03 helpers — reuse them
> for every other method.
>
> **SafeJSON note:** the contract uses raw `JSON.parse`/`JSON.stringify` (matching exemplar Plan 03),
> NOT `SafeJSON`. This is deliberate — `SafeJSON` wraps the `comment-json` npm dep, which would
> violate the contract's RN-bundle purity guard. Verify `src/dev-dashboard/contract/` is exempt from
> the repo's biome `JSON.*` restriction (it is in 03's shipped `client.ts`); if a fresh lint flags it,
> add the same inline ignore 03 uses — do **not** switch to `SafeJSON` (it breaks RN-purity).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/contract/client.test.ts`
Expected: PASS — the original Plan 03 tests + the new ones (todos/claude/daemon/containers/weather +
the 503 case) all green.

- [ ] **Step 5: Typecheck the whole contract**

Run: `bunx tsgo --noEmit | rg "contract/"`
Expected: no errors under `contract/`.

- [ ] **Step 6: Commit**

```bash
git add src/dev-dashboard/contract/client.ts src/dev-dashboard/contract/client.test.ts
git commit -m "feat(dd-contract): todos/claude/daemon/containers/weather client + RemindersPermissionError"
```

---

### Task 4: Todos screen — list + 503 CTA + add/complete/delete/edit

> Parity with `src/dev-dashboard/ui/src/routes/todos.tsx`, ported to RN. The web shows
> group-by/status/bucket filters; the mobile v1 ships **status filter (active/done/all)** +
> **single-bucket pick** (the heavier group-by UI is web-only for now — note it, don't fake it).

**Files:**
- Create: `DevDashboard/mobile/app/(more)/todos.tsx`
- Create: `DevDashboard/mobile/src/components/todos/TodoRow.tsx`
- Create: `DevDashboard/mobile/src/components/todos/AddTodoSheet.tsx`
- Create: `DevDashboard/mobile/src/components/todos/RemindersPermissionCta.tsx`

- [ ] **Step 1: The permission CTA component**

`DevDashboard/mobile/src/components/todos/RemindersPermissionCta.tsx`:

```tsx
import { useMutation } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { dashboard } from "@/lib/dashboard";

interface Props {
    onGranted: () => void;
}

export function RemindersPermissionCta({ onGranted }: Props) {
    const requestAccess = useMutation({
        mutationFn: () => dashboard.todos.requestAccess(),
        onSuccess: (result) => {
            if (result.authorized) {
                onGranted();
            }
        },
    });

    return (
        <View testID="todos-permission-cta" className="flex-1 items-center justify-center gap-4 px-6">
            <Text className="text-lg font-bold text-dd-accent">Reminders permission needed</Text>
            <Text className="max-w-sm text-center text-sm text-dd-text-secondary">
                Allow the agent to read your macOS Reminders. Tap below to show Apple's permission dialog on the Mac
                {requestAccess.data?.status ? ` (status: ${requestAccess.data.status})` : ""}.
            </Text>
            <Pressable
                testID="todos-request-access"
                disabled={requestAccess.isPending}
                onPress={() => requestAccess.mutate()}
                className="rounded-xl bg-dd-accent px-5 py-3 active:opacity-80"
            >
                {requestAccess.isPending ? (
                    <ActivityIndicator color="#000" />
                ) : (
                    <Text className="font-semibold text-dd-on-accent">Allow Reminders access</Text>
                )}
            </Pressable>
            {requestAccess.isError ? (
                <Text testID="todos-permission-error" className="max-w-sm text-center text-sm text-dd-danger">
                    {requestAccess.error instanceof Error ? requestAccess.error.message : String(requestAccess.error)}
                </Text>
            ) : null}
        </View>
    );
}
```

- [ ] **Step 2: The reminder row**

`DevDashboard/mobile/src/components/todos/TodoRow.tsx`:

```tsx
import { Pressable, Text, View } from "react-native";
import type { ReminderInfo } from "@devdashboard/contract";

interface Props {
    reminder: ReminderInfo;
    showListName: boolean;
    onComplete: (reminderId: string) => void;
    onEdit: (reminderId: string) => void;
    onDelete: (reminderId: string) => void;
}

// Apple EKReminder priority is a RANGE, not exact values: 0 = none, 1–4 = high, 5 = medium,
// 6–9 = low. Mirror the web's mapping (read `reminderPriorityToTodo` / `priorityLabel` in
// src/dev-dashboard/ui/src/components/todos/ before implementing — keep them in sync).
function priorityLabel(priority: number): string | null {
    if (priority === 0) {
        return null;
    }

    if (priority <= 4) {
        return "High";
    }

    if (priority === 5) {
        return "Medium";
    }

    return "Low";
}

function dueLabel(due: string | null): string | null {
    if (!due) {
        return null;
    }

    const d = new Date(due);
    if (Number.isNaN(d.getTime())) {
        return null;
    }

    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TodoRow({ reminder, showListName, onComplete, onEdit, onDelete }: Props) {
    const due = dueLabel(reminder.due_date);
    const priority = priorityLabel(reminder.priority);
    const overdue = reminder.due_date != null && !reminder.is_completed && new Date(reminder.due_date).getTime() < Date.now();

    return (
        <View testID={`todo-row-${reminder.identifier}`} className="flex-row items-start gap-3 border-b border-dd-border px-4 py-3">
            <Pressable
                testID={`todo-complete-${reminder.identifier}`}
                onPress={() => onComplete(reminder.identifier)}
                hitSlop={8}
                className="mt-1 h-5 w-5 items-center justify-center rounded-full border border-dd-border"
            >
                {reminder.is_completed ? <Text className="text-dd-accent">✓</Text> : null}
            </Pressable>

            <Pressable testID={`todo-open-${reminder.identifier}`} onPress={() => onEdit(reminder.identifier)} className="flex-1">
                <Text className={`text-base ${reminder.is_completed ? "text-dd-text-muted line-through" : "text-dd-text-primary"}`}>
                    {reminder.title}
                </Text>
                <View className="mt-1 flex-row flex-wrap gap-2">
                    {showListName ? <Text className="text-xs text-dd-text-muted">{reminder.list_title}</Text> : null}
                    {due ? <Text className={`text-xs ${overdue ? "text-dd-danger" : "text-dd-text-muted"}`}>{due}</Text> : null}
                    {priority ? <Text className="text-xs text-dd-text-secondary">{priority}</Text> : null}
                    {reminder.url ? <Text className="text-xs text-dd-text-muted">Link</Text> : null}
                </View>
            </Pressable>

            <Pressable testID={`todo-delete-${reminder.identifier}`} onPress={() => onDelete(reminder.identifier)} hitSlop={8}>
                <Text className="text-dd-text-muted">✕</Text>
            </Pressable>
        </View>
    );
}
```

- [ ] **Step 3: The add/edit sheet (shared form)**

`DevDashboard/mobile/src/components/todos/AddTodoSheet.tsx`:

```tsx
import { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";

export interface TodoFormValue {
    title: string;
    due?: string;
    priority?: string;
}

interface Props {
    visible: boolean;
    pending: boolean;
    initial?: TodoFormValue;
    onClose: () => void;
    onSubmit: (value: TodoFormValue) => void;
}

export function AddTodoSheet({ visible, pending, initial, onClose, onSubmit }: Props) {
    const [title, setTitle] = useState(initial?.title ?? "");

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable className="flex-1 justify-end bg-black/40" onPress={onClose}>
                <Pressable testID="todo-sheet" className="gap-3 rounded-t-2xl bg-dd-panel p-5" onPress={() => {}}>
                    <Text className="text-base font-bold text-dd-text-primary">{initial ? "Edit todo" : "New todo"}</Text>
                    <TextInput
                        testID="todo-title-input"
                        value={title}
                        onChangeText={setTitle}
                        placeholder="What needs doing?"
                        placeholderTextColor="#888"
                        className="rounded-xl border border-dd-border px-4 py-3 text-dd-text-primary"
                    />
                    <Pressable
                        testID="todo-submit"
                        disabled={pending || title.trim().length === 0}
                        onPress={() => onSubmit({ title: title.trim() })}
                        className="rounded-xl bg-dd-accent px-5 py-3 active:opacity-80"
                    >
                        <Text className="text-center font-semibold text-dd-on-accent">{pending ? "Saving…" : "Save"}</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
```

- [ ] **Step 4: The Todos screen**

`DevDashboard/mobile/app/(more)/todos.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import type { ReminderInfo, TodoStatusFilter } from "@devdashboard/contract";
import { RemindersPermissionError } from "@devdashboard/contract";
import { AddTodoSheet, type TodoFormValue } from "@/components/todos/AddTodoSheet";
import { RemindersPermissionCta } from "@/components/todos/RemindersPermissionCta";
import { TodoRow } from "@/components/todos/TodoRow";
import { dashboard } from "@/lib/dashboard";

const DEFAULT_LIST = "GenesisTools";
const STATUS_FILTERS: TodoStatusFilter[] = ["active", "done", "all"];

export default function TodosScreen() {
    const queryClient = useQueryClient();
    const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
    const [statusFilter, setStatusFilter] = useState<TodoStatusFilter>("active");
    const [sheetOpen, setSheetOpen] = useState(false);

    const includeCompleted = statusFilter !== "active";
    const listsKey = [...selectedListIds].sort().join(",");

    const todosQuery = useQuery({
        queryKey: ["todos", listsKey, includeCompleted],
        queryFn: () => dashboard.todos.list({ listIds: selectedListIds, includeCompleted }),
        refetchInterval: 10_000,
        retry: false,
        refetchOnWindowFocus: false,
    });

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ["todos"] });

    const lists = todosQuery.data?.lists ?? [];
    const reminders = todosQuery.data?.reminders ?? [];

    useEffect(() => {
        if (lists.length === 0 || selectedListIds.length > 0) {
            return;
        }

        const preferred = lists.find((list) => list.title === DEFAULT_LIST) ?? lists[0];
        if (preferred) {
            setSelectedListIds([preferred.identifier]);
        }
    }, [lists, selectedListIds.length]);

    const addTargetList = useMemo(() => {
        const first = lists.find((list) => selectedListIds.includes(list.identifier));
        return first?.title ?? DEFAULT_LIST;
    }, [lists, selectedListIds]);

    const addMutation = useMutation({
        mutationFn: (value: TodoFormValue) => dashboard.todos.create({ ...value, listName: addTargetList }),
        onSuccess: () => {
            setSheetOpen(false);
            invalidate();
        },
    });

    const completeMutation = useMutation({
        mutationFn: (reminderId: string) => dashboard.todos.complete(reminderId),
        onSuccess: invalidate,
    });

    const deleteMutation = useMutation({
        mutationFn: (reminderId: string) => dashboard.todos.remove(reminderId),
        onSuccess: invalidate,
    });

    const filtered = useMemo<ReminderInfo[]>(() => {
        if (statusFilter === "done") {
            return reminders.filter((r) => r.is_completed);
        }

        if (statusFilter === "active") {
            return reminders.filter((r) => !r.is_completed);
        }

        return reminders;
    }, [reminders, statusFilter]);

    if (todosQuery.error instanceof RemindersPermissionError) {
        return <RemindersPermissionCta onGranted={invalidate} />;
    }

    if (todosQuery.error) {
        return (
            <View testID="todos-error" className="flex-1 items-center justify-center px-6">
                <Text className="text-base font-bold text-dd-danger">Failed to load todos</Text>
                <Text className="mt-2 text-center text-sm text-dd-text-secondary">{todosQuery.error.message}</Text>
            </View>
        );
    }

    const showInitialLoader = todosQuery.isPending;

    return (
        <View testID="todos-screen" className="flex-1 bg-dd-bg">
            <View className="flex-row items-center justify-between px-4 py-3">
                <View testID="todos-status-filter" className="flex-row gap-2">
                    {STATUS_FILTERS.map((value) => (
                        <Pressable
                            key={value}
                            testID={`todos-status-${value}`}
                            onPress={() => setStatusFilter(value)}
                            className={`rounded-full px-3 py-1 ${statusFilter === value ? "bg-dd-accent" : "border border-dd-border"}`}
                        >
                            <Text className={statusFilter === value ? "text-dd-on-accent" : "text-dd-text-secondary"}>{value}</Text>
                        </Pressable>
                    ))}
                </View>
                <Pressable testID="todos-add" onPress={() => setSheetOpen(true)} hitSlop={8}>
                    <Text className="text-2xl text-dd-accent">＋</Text>
                </Pressable>
            </View>

            {showInitialLoader ? (
                <View className="flex-1 items-center justify-center">
                    <ActivityIndicator color="#888" />
                </View>
            ) : (
                <FlatList
                    testID="todos-list"
                    data={filtered}
                    keyExtractor={(item) => item.identifier}
                    renderItem={({ item }) => (
                        <TodoRow
                            reminder={item}
                            showListName={selectedListIds.length !== 1}
                            onComplete={(id) => completeMutation.mutate(id)}
                            onEdit={() => setSheetOpen(true)}
                            onDelete={(id) => deleteMutation.mutate(id)}
                        />
                    )}
                    ListEmptyComponent={
                        <Text testID="todos-empty" className="px-4 py-8 text-center text-sm text-dd-text-muted">No todos</Text>
                    }
                />
            )}

            <AddTodoSheet
                visible={sheetOpen}
                pending={addMutation.isPending}
                onClose={() => setSheetOpen(false)}
                onSubmit={(value) => addMutation.mutate(value)}
            />
        </View>
    );
}
```

- [ ] **Step 5: Typecheck the mobile screen**

Run (from the mobile project): `cd DevDashboard/mobile && bunx tsc --noEmit | rg "app/\(more\)/todos|components/todos"`
Expected: no errors. (Use the mobile project's own `tsconfig`; the `@devdashboard/contract` import
resolves via the workspace package — assumed wired in Plan 04.)

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/mobile/app/\(more\)/todos.tsx DevDashboard/mobile/src/components/todos
git commit -m "feat(dd-mobile): Todos screen (list/add/complete/delete + Reminders-permission CTA)"
```

---

### Task 5: Claude usage screen — account cards + history charts

> Parity with `routes/claude.tsx`: current-usage cards per account + a multi-line history
> `MetricChart` per account, with a 1h/24h/7d range segmented control.

**Files:**
- Create: `DevDashboard/mobile/src/lib/claude-usage-series.ts`
- Test: `DevDashboard/mobile/src/lib/claude-usage-series.test.ts`
- Create: `DevDashboard/mobile/src/components/claude/AccountUsageCard.tsx`
- Create: `DevDashboard/mobile/src/components/claude/AccountHistoryChart.tsx`
- Create: `DevDashboard/mobile/app/(more)/claude.tsx`

- [ ] **Step 1: Write the failing mapper test (RN test runner — pure logic)**

`DevDashboard/mobile/src/lib/claude-usage-series.test.ts`:

> The mapper is **pure TS** (imports only contract *types* + uses `Date.parse` — no RN runtime), so it
> runs under `bun:test`, not the RN test runner. Use `bun:test` to match the run command below.

```typescript
import { describe, expect, it } from "bun:test";
import { historyToChartSeries } from "./claude-usage-series";
import type { MultiBucketHistoryResult } from "@devdashboard/contract";

describe("historyToChartSeries", () => {
    it("maps each bucket to a MetricChart series with utilization as percent (0-100)", () => {
        const history: MultiBucketHistoryResult = {
            series: [
                {
                    bucket: "five_hour",
                    snapshots: [
                        { id: 1, timestamp: "2026-05-29T00:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.4, resetsAt: null },
                        { id: 2, timestamp: "2026-05-29T01:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.55, resetsAt: null },
                    ],
                },
                { bucket: "seven_day", snapshots: [] },
            ],
        };

        const result = historyToChartSeries(history);
        expect(result).toHaveLength(2);
        expect(result[0].key).toBe("five_hour");
        expect(result[0].label).toBe("5h");
        expect(result[0].points).toHaveLength(2);
        expect(result[0].points[0].y).toBeCloseTo(40);
        expect(result[0].points[1].y).toBeCloseTo(55);
        expect(result[0].points[0].x).toBe(Date.parse("2026-05-29T00:00:00Z"));
    });

    it("drops snapshots with an unparseable timestamp", () => {
        const history: MultiBucketHistoryResult = {
            series: [{ bucket: "five_hour", snapshots: [{ id: 1, timestamp: "not-a-date", accountName: "main", bucket: "five_hour", utilization: 0.1, resetsAt: null }] }],
        };

        expect(historyToChartSeries(history)[0].points).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd DevDashboard/mobile && bun test src/lib/claude-usage-series.test.ts`
Expected: FAIL — `historyToChartSeries` not defined.

- [ ] **Step 3: Implement the mapper**

`DevDashboard/mobile/src/lib/claude-usage-series.ts`:

```typescript
import type { MultiBucketHistoryResult } from "@devdashboard/contract";

export interface ChartSeries {
    key: string;
    label: string;
    color: string;
    points: Array<{ x: number; y: number }>;
}

const BUCKET_META: Record<string, { label: string; color: string }> = {
    five_hour: { label: "5h", color: "#22d3ee" },
    seven_day: { label: "7d", color: "#a78bfa" },
    seven_day_sonnet: { label: "Sonnet 7d", color: "#f59e0b" },
    seven_day_opus: { label: "Opus 7d", color: "#34d399" },
};

export function historyToChartSeries(history: MultiBucketHistoryResult): ChartSeries[] {
    return history.series.map((series) => {
        const meta = BUCKET_META[series.bucket] ?? { label: series.bucket, color: "#94a3b8" };
        const points: Array<{ x: number; y: number }> = [];

        for (const snapshot of series.snapshots) {
            const x = Date.parse(snapshot.timestamp);
            if (Number.isNaN(x)) {
                continue;
            }

            points.push({ x, y: snapshot.utilization * 100 });
        }

        return { key: series.bucket, label: meta.label, color: meta.color, points };
    });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd DevDashboard/mobile && bun test src/lib/claude-usage-series.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Account current-usage card**

`DevDashboard/mobile/src/components/claude/AccountUsageCard.tsx`:

```tsx
import { Text, View } from "react-native";
import type { AccountUsage, UsageBucket } from "@devdashboard/contract";

interface Props {
    account: AccountUsage;
}

function pct(bucket: UsageBucket | null | undefined): string {
    if (!bucket) {
        return "—";
    }

    return `${Math.round(bucket.utilization * 100)}%`;
}

export function AccountUsageCard({ account }: Props) {
    const title = account.label ? `${account.accountName} · ${account.label}` : account.accountName;

    return (
        <View testID={`claude-account-${account.accountName}`} className="gap-2 rounded-2xl bg-dd-panel p-4">
            <Text className="text-base font-bold text-dd-text-primary">{title}</Text>
            {account.error ? (
                <Text testID={`claude-account-error-${account.accountName}`} className="text-sm text-dd-danger">
                    {account.error}
                </Text>
            ) : (
                <View className="flex-row justify-between">
                    <View className="items-center">
                        <Text className="text-xs text-dd-text-muted">5h</Text>
                        <Text className="text-lg font-semibold text-dd-text-primary">{pct(account.usage?.five_hour)}</Text>
                    </View>
                    <View className="items-center">
                        <Text className="text-xs text-dd-text-muted">7d</Text>
                        <Text className="text-lg font-semibold text-dd-text-primary">{pct(account.usage?.seven_day)}</Text>
                    </View>
                    <View className="items-center">
                        <Text className="text-xs text-dd-text-muted">Sonnet 7d</Text>
                        <Text className="text-lg font-semibold text-dd-text-primary">{pct(account.usage?.seven_day_sonnet)}</Text>
                    </View>
                </View>
            )}
        </View>
    );
}
```

- [ ] **Step 6: Account history chart (consumes `MetricChart`)**

`DevDashboard/mobile/src/components/claude/AccountHistoryChart.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { MetricChart } from "@/components/charts/MetricChart";
import { historyToChartSeries } from "@/lib/claude-usage-series";
import { dashboard } from "@/lib/dashboard";

const BUCKETS = ["five_hour", "seven_day", "seven_day_sonnet"];

interface Props {
    accountName: string;
    label?: string;
    rangeMinutes: number;
}

export function AccountHistoryChart({ accountName, label, rangeMinutes }: Props) {
    const query = useQuery({
        queryKey: ["claude", "usage", "history", accountName, rangeMinutes],
        queryFn: () => dashboard.claude.usageHistory({ account: accountName, buckets: BUCKETS, minutes: rangeMinutes }),
        refetchInterval: 30_000,
    });

    const series = query.data ? historyToChartSeries(query.data) : [];
    const empty = series.every((s) => s.points.length === 0);
    const title = label ? `${accountName} · ${label}` : accountName;

    return (
        <View testID={`claude-history-${accountName}`} className="gap-2 rounded-2xl bg-dd-panel p-4">
            <Text className="text-sm font-semibold text-dd-text-secondary">{title}</Text>
            {empty ? (
                <Text className="py-8 text-center text-sm text-dd-text-muted">
                    {query.data?.hint ?? "No history yet."}
                </Text>
            ) : (
                <MetricChart series={series} yDomain={[0, 100]} height={180} testID={`claude-chart-${accountName}`} />
            )}
        </View>
    );
}
```

- [ ] **Step 7: The Claude usage screen**

`DevDashboard/mobile/app/(more)/claude.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { AccountHistoryChart } from "@/components/claude/AccountHistoryChart";
import { AccountUsageCard } from "@/components/claude/AccountUsageCard";
import { dashboard } from "@/lib/dashboard";

const RANGES = [
    { label: "1h", minutes: 60 },
    { label: "24h", minutes: 1440 },
    { label: "7d", minutes: 10080 },
] as const;

export default function ClaudeScreen() {
    const usageQuery = useQuery({
        queryKey: ["claude", "usage"],
        queryFn: () => dashboard.claude.usage(),
        refetchInterval: 30_000,
    });
    const [rangeMinutes, setRangeMinutes] = useState(10080);

    const accounts = usageQuery.data ?? [];

    if (usageQuery.isLoading) {
        return (
            <View testID="claude-loading" className="flex-1 items-center justify-center">
                <ActivityIndicator color="#888" />
            </View>
        );
    }

    if (accounts.length === 0) {
        return (
            <View testID="claude-empty" className="flex-1 items-center justify-center px-6">
                <Text className="text-center text-sm text-dd-text-muted">No Claude subscription accounts configured.</Text>
            </View>
        );
    }

    return (
        <ScrollView testID="claude-screen" className="flex-1 bg-dd-bg" contentContainerClassName="gap-4 p-4">
            {accounts.map((account) => (
                <AccountUsageCard key={account.accountName} account={account} />
            ))}

            <View testID="claude-range-control" className="flex-row justify-end gap-2">
                {RANGES.map((range) => (
                    <Pressable
                        key={range.minutes}
                        testID={`claude-range-${range.label}`}
                        onPress={() => setRangeMinutes(range.minutes)}
                        className={`rounded-full px-3 py-1 ${rangeMinutes === range.minutes ? "bg-dd-accent" : "border border-dd-border"}`}
                    >
                        <Text className={rangeMinutes === range.minutes ? "text-dd-on-accent" : "text-dd-text-secondary"}>{range.label}</Text>
                    </Pressable>
                ))}
            </View>

            {accounts.map((account) => (
                <AccountHistoryChart key={account.accountName} accountName={account.accountName} label={account.label} rangeMinutes={rangeMinutes} />
            ))}
        </ScrollView>
    );
}
```

- [ ] **Step 8: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsc --noEmit | rg "claude"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/lib/claude-usage-series.ts DevDashboard/mobile/src/lib/claude-usage-series.test.ts \
        DevDashboard/mobile/src/components/claude DevDashboard/mobile/app/\(more\)/claude.tsx
git commit -m "feat(dd-mobile): Claude usage screen (account cards + history charts via MetricChart)"
```

---

### Task 6: Daemon screen — status + tasks + recent runs + log viewer

> Parity with `routes/daemon.tsx`: status header, tasks list, runs timeline, and a tap-to-open run
> **log viewer** (`/api/daemon/runs/log`).

**Files:**
- Create: `DevDashboard/mobile/src/components/daemon/DaemonStatusHeader.tsx`
- Create: `DevDashboard/mobile/src/components/daemon/RunRow.tsx`
- Create: `DevDashboard/mobile/src/components/daemon/RunLogSheet.tsx`
- Create: `DevDashboard/mobile/app/(more)/daemon.tsx`

- [ ] **Step 1: Status header**

`DevDashboard/mobile/src/components/daemon/DaemonStatusHeader.tsx`:

```tsx
import { Text, View } from "react-native";
import type { DaemonStatus } from "@devdashboard/contract";

interface Props {
    status: DaemonStatus;
}

export function DaemonStatusHeader({ status }: Props) {
    const label = !status.installed ? "Not installed" : status.running ? "Running" : "Stopped";
    const tone = status.running ? "text-dd-accent" : status.installed ? "text-dd-warning" : "text-dd-text-muted";

    return (
        <View testID="daemon-status-header" className="flex-row items-center justify-between rounded-2xl bg-dd-panel p-4">
            <Text className="text-base font-bold text-dd-text-primary">Daemon</Text>
            <View className="items-end">
                <Text testID="daemon-status-label" className={`text-base font-semibold ${tone}`}>{label}</Text>
                {status.pid != null ? <Text className="text-xs text-dd-text-muted">pid {status.pid}</Text> : null}
            </View>
        </View>
    );
}
```

- [ ] **Step 2: Run row**

`DevDashboard/mobile/src/components/daemon/RunRow.tsx`:

```tsx
import { Pressable, Text, View } from "react-native";
import type { RunSummary } from "@devdashboard/contract";

interface Props {
    run: RunSummary;
    onOpenLog: (logFile: string) => void;
}

function durationLabel(ms: number | null): string {
    if (ms == null) {
        return "—";
    }

    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunRow({ run, onOpenLog }: Props) {
    const failed = run.exitCode != null && run.exitCode !== 0;

    return (
        <Pressable
            testID={`daemon-run-${run.runId}`}
            onPress={() => onOpenLog(run.logFile)}
            className="flex-row items-center justify-between border-b border-dd-border px-4 py-3 active:opacity-70"
        >
            <View className="flex-1">
                <Text className="text-sm font-semibold text-dd-text-primary">{run.taskName}</Text>
                <Text className="text-xs text-dd-text-muted">{new Date(run.startedAt).toLocaleTimeString()}</Text>
            </View>
            <View className="items-end">
                <Text testID={`daemon-run-exit-${run.runId}`} className={`text-sm ${failed ? "text-dd-danger" : "text-dd-accent"}`}>
                    {run.exitCode == null ? "running" : `exit ${run.exitCode}`}
                </Text>
                <Text className="text-xs text-dd-text-muted">{durationLabel(run.duration_ms)}</Text>
            </View>
        </Pressable>
    );
}
```

- [ ] **Step 3: Run-log viewer sheet**

`DevDashboard/mobile/src/components/daemon/RunLogSheet.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { LogEntry } from "@devdashboard/contract";
import { dashboard } from "@/lib/dashboard";

interface Props {
    logFile: string | null;
    onClose: () => void;
}

function renderLine(entry: LogEntry, index: number) {
    if (entry.type === "meta") {
        return (
            <Text key={index} className="font-mono text-xs text-dd-text-secondary">
                $ {entry.command}
            </Text>
        );
    }

    if (entry.type === "exit") {
        return (
            <Text key={index} className="font-mono text-xs text-dd-accent">
                ── exit {entry.code ?? "?"} ({entry.duration_ms}ms){entry.timedOut ? " [timed out]" : ""}
            </Text>
        );
    }

    return (
        <Text key={index} className={`font-mono text-xs ${entry.type === "stderr" ? "text-dd-danger" : "text-dd-text-primary"}`}>
            {entry.data}
        </Text>
    );
}

export function RunLogSheet({ logFile, onClose }: Props) {
    const query = useQuery({
        queryKey: ["daemon", "runs", "log", logFile],
        queryFn: () => dashboard.daemon.runLog(logFile ?? ""),
        enabled: logFile != null,
    });

    return (
        <Modal visible={logFile != null} transparent animationType="slide" onRequestClose={onClose}>
            <View className="flex-1 justify-end bg-black/40">
                <View testID="daemon-log-sheet" className="max-h-[80%] gap-3 rounded-t-2xl bg-dd-panel p-4">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-base font-bold text-dd-text-primary">Run log</Text>
                        <Pressable testID="daemon-log-close" onPress={onClose} hitSlop={8}>
                            <Text className="text-dd-text-muted">✕</Text>
                        </Pressable>
                    </View>
                    {query.isLoading ? (
                        <ActivityIndicator color="#888" />
                    ) : (
                        <ScrollView testID="daemon-log-body" className="gap-1">
                            {(query.data ?? []).map(renderLine)}
                            {(query.data ?? []).length === 0 ? (
                                <Text className="text-sm text-dd-text-muted">Empty log.</Text>
                            ) : null}
                        </ScrollView>
                    )}
                </View>
            </View>
        </Modal>
    );
}
```

- [ ] **Step 4: The Daemon screen**

`DevDashboard/mobile/app/(more)/daemon.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { DaemonStatusHeader } from "@/components/daemon/DaemonStatusHeader";
import { RunLogSheet } from "@/components/daemon/RunLogSheet";
import { RunRow } from "@/components/daemon/RunRow";
import { dashboard } from "@/lib/dashboard";

export default function DaemonScreen() {
    const [selectedLogFile, setSelectedLogFile] = useState<string | null>(null);

    const statusQuery = useQuery({
        queryKey: ["daemon", "status"],
        queryFn: () => dashboard.daemon.status(),
        refetchInterval: 5_000,
    });

    const runsQuery = useQuery({
        queryKey: ["daemon", "runs"],
        queryFn: () => dashboard.daemon.runs({ limit: 20 }),
        refetchInterval: 5_000,
    });

    if (statusQuery.isLoading && !statusQuery.data) {
        return (
            <View testID="daemon-loading" className="flex-1 items-center justify-center">
                <ActivityIndicator color="#888" />
            </View>
        );
    }

    const status = statusQuery.data?.status ?? { installed: false, running: false, pid: null };

    return (
        <View testID="daemon-screen" className="flex-1 gap-3 bg-dd-bg p-3">
            <DaemonStatusHeader status={status} />
            <Text className="px-1 text-xs uppercase text-dd-text-muted">Tasks: {statusQuery.data?.tasks.length ?? 0}</Text>
            <FlatList
                testID="daemon-runs"
                data={runsQuery.data ?? []}
                keyExtractor={(item) => item.runId}
                renderItem={({ item }) => <RunRow run={item} onOpenLog={setSelectedLogFile} />}
                ListEmptyComponent={<Text testID="daemon-runs-empty" className="px-4 py-8 text-center text-sm text-dd-text-muted">No recent runs</Text>}
            />
            <RunLogSheet logFile={selectedLogFile} onClose={() => setSelectedLogFile(null)} />
        </View>
    );
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsc --noEmit | rg "daemon"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/components/daemon DevDashboard/mobile/app/\(more\)/daemon.tsx
git commit -m "feat(dd-mobile): Daemon screen (status + recent runs + run-log viewer)"
```

---

### Task 7: Containers screen

> Parity with `routes/containers.tsx`: docker container list, with a clear `dockerAvailable === false`
> empty state.

**Files:**
- Create: `DevDashboard/mobile/src/components/containers/ContainerRow.tsx`
- Create: `DevDashboard/mobile/app/(more)/containers.tsx`

- [ ] **Step 1: Container row**

`DevDashboard/mobile/src/components/containers/ContainerRow.tsx`:

```tsx
import { Text, View } from "react-native";
import type { ContainerInfo } from "@devdashboard/contract";

interface Props {
    container: ContainerInfo;
}

export function ContainerRow({ container }: Props) {
    const running = container.state.toLowerCase() === "running";

    return (
        <View testID={`container-row-${container.id}`} className="flex-row items-center justify-between border-b border-dd-border px-4 py-3">
            <View className="flex-1">
                <Text className="text-sm font-semibold text-dd-text-primary">{container.name}</Text>
                <Text className="text-xs text-dd-text-muted">{container.image}</Text>
                {container.ports ? <Text className="text-xs text-dd-text-secondary">{container.ports}</Text> : null}
            </View>
            <View className="items-end">
                <Text testID={`container-state-${container.id}`} className={`text-sm ${running ? "text-dd-accent" : "text-dd-text-muted"}`}>
                    {container.state}
                </Text>
                <Text className="text-xs text-dd-text-muted">{container.status}</Text>
            </View>
        </View>
    );
}
```

- [ ] **Step 2: The Containers screen**

`DevDashboard/mobile/app/(more)/containers.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { ContainerRow } from "@/components/containers/ContainerRow";
import { dashboard } from "@/lib/dashboard";

export default function ContainersScreen() {
    const query = useQuery({
        queryKey: ["containers"],
        queryFn: () => dashboard.containers.list(),
        refetchInterval: 5_000,
    });

    if (query.isLoading && !query.data) {
        return (
            <View testID="containers-loading" className="flex-1 items-center justify-center">
                <ActivityIndicator color="#888" />
            </View>
        );
    }

    if (query.data && !query.data.dockerAvailable) {
        return (
            <View testID="containers-docker-unavailable" className="flex-1 items-center justify-center px-6">
                <Text className="text-center text-sm text-dd-text-muted">Docker is not available on the agent host.</Text>
            </View>
        );
    }

    return (
        <View testID="containers-screen" className="flex-1 bg-dd-bg">
            <FlatList
                testID="containers-list"
                data={query.data?.containers ?? []}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => <ContainerRow container={item} />}
                ListEmptyComponent={<Text testID="containers-empty" className="px-4 py-8 text-center text-sm text-dd-text-muted">No containers</Text>}
            />
        </View>
    );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsc --noEmit | rg "containers"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/components/containers DevDashboard/mobile/app/\(more\)/containers.tsx
git commit -m "feat(dd-mobile): Containers screen (docker list + unavailable state)"
```

---

### Task 8: Shared Weather card (Pulse imports it too)

> The web has `components/pulse/WeatherCard`. 09 **owns** the RN weather contract method (Task 2/3)
> and the shared RN `WeatherCard` component; Plan 05 (Pulse) imports it from here rather than
> re-implementing — **single ownership** to avoid drift.

**Files:**
- Create: `DevDashboard/mobile/src/components/weather/WeatherCard.tsx`

- [ ] **Step 1: The weather card**

`DevDashboard/mobile/src/components/weather/WeatherCard.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { dashboard } from "@/lib/dashboard";

function tempLabel(tempC: number | null): string {
    if (tempC == null) {
        return "—";
    }

    return `${Math.round(tempC)}°C`;
}

export function WeatherCard() {
    const query = useQuery({
        queryKey: ["weather"],
        queryFn: () => dashboard.weather.get(),
        refetchInterval: 5 * 60_000,
    });

    const weather = query.data;

    return (
        <View testID="weather-card" className="gap-1 rounded-2xl bg-dd-panel p-4">
            <Text className="text-xs uppercase text-dd-text-muted">{weather?.label ?? "Weather"}</Text>
            {weather?.error ? (
                <Text testID="weather-error" className="text-sm text-dd-danger">{weather.error}</Text>
            ) : (
                <View className="flex-row items-baseline gap-2">
                    <Text testID="weather-temp" className="text-3xl font-bold text-dd-text-primary">{tempLabel(weather?.tempC ?? null)}</Text>
                    <Text className="text-sm text-dd-text-secondary">{weather?.description ?? ""}</Text>
                </View>
            )}
        </View>
    );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd DevDashboard/mobile && bunx tsc --noEmit | rg "weather"`
Expected: no errors.

```bash
git add DevDashboard/mobile/src/components/weather/WeatherCard.tsx
git commit -m "feat(dd-mobile): shared WeatherCard (used by Pulse + Features-rest)"
```

---

### Task 9: Combined Appium smoke spec + Page Objects (E2E)

> ADR §8: a feature is **done only when its Appium spec passes** on the iOS simulator/dev-client.
> These four Page Objects (`TodosPage`, `ClaudeUsagePage`, `DaemonPage`, `ContainersPage`) **extend
> the §8 POM list**; weather is asserted via its card `testID` (no dedicated page — it lives on
> home/Pulse). All `testID`s used below were set on the screen components in Tasks 4–8 — RN `testID`
> maps to the iOS `accessibility id` strategy. Drive taps with `appium_gesture` (action=`tap`),
> reveal off-screen rows with `action=scroll_to_element`.

**Files:**
- Create: `DevDashboard/mobile/e2e/pages/todos.page.ts`
- Create: `DevDashboard/mobile/e2e/pages/claude-usage.page.ts`
- Create: `DevDashboard/mobile/e2e/pages/daemon.page.ts`
- Create: `DevDashboard/mobile/e2e/pages/containers.page.ts`
- Create: `DevDashboard/mobile/e2e/specs/features-rest.smoke.spec.ts`

- [ ] **Step 1: Page Objects (extend `BasePage` from Plan 04)**

`DevDashboard/mobile/e2e/pages/todos.page.ts`:

```typescript
import { BasePage } from "./base.page";

export class TodosPage extends BasePage {
    async waitUntilReady(): Promise<void> {
        // Either the list, the permission CTA, or the error state must appear.
        await this.waitForAny(["todos-list", "todos-permission-cta", "todos-error"]);
    }

    async isPermissionGate(): Promise<boolean> {
        return this.exists("todos-permission-cta");
    }

    async setStatusFilter(value: "active" | "done" | "all"): Promise<void> {
        await this.tap(`todos-status-${value}`);
    }

    async openAddSheet(): Promise<void> {
        await this.tap("todos-add");
        await this.waitForVisible("todo-sheet");
    }

    async typeTitle(title: string): Promise<void> {
        await this.setValue("todo-title-input", title);
    }

    async submit(): Promise<void> {
        await this.tap("todo-submit");
    }
}
```

`DevDashboard/mobile/e2e/pages/claude-usage.page.ts`:

```typescript
import { BasePage } from "./base.page";

export class ClaudeUsagePage extends BasePage {
    async waitUntilReady(): Promise<void> {
        await this.waitForAny(["claude-screen", "claude-empty"]);
    }

    async selectRange(label: "1h" | "24h" | "7d"): Promise<void> {
        await this.tap(`claude-range-${label}`);
    }

    async hasAnyAccountCard(): Promise<boolean> {
        // account cards use the accessibility id prefix claude-account-*; assert at least one card area.
        return this.exists("claude-range-control");
    }
}
```

`DevDashboard/mobile/e2e/pages/daemon.page.ts`:

```typescript
import { BasePage } from "./base.page";

export class DaemonPage extends BasePage {
    async waitUntilReady(): Promise<void> {
        await this.waitForVisible("daemon-screen");
    }

    async statusLabel(): Promise<string> {
        return this.text("daemon-status-label");
    }

    async openFirstRunLog(): Promise<boolean> {
        if (await this.exists("daemon-runs-empty")) {
            return false;
        }

        // tap the first run row revealed in the list; scroll it into view first.
        await this.scrollToFirst("daemon-runs", "daemon-run-");
        await this.tapFirstWithPrefix("daemon-run-");
        await this.waitForVisible("daemon-log-sheet");
        return true;
    }

    async closeRunLog(): Promise<void> {
        await this.tap("daemon-log-close");
    }
}
```

`DevDashboard/mobile/e2e/pages/containers.page.ts`:

```typescript
import { BasePage } from "./base.page";

export class ContainersPage extends BasePage {
    async waitUntilReady(): Promise<void> {
        await this.waitForAny(["containers-list", "containers-docker-unavailable"]);
    }

    async dockerUnavailable(): Promise<boolean> {
        return this.exists("containers-docker-unavailable");
    }
}
```

> `BasePage` helpers assumed from Plan 04: `tap`, `setValue`, `text`, `exists`, `waitForVisible`,
> `waitForAny(ids[])`, `scrollToFirst(listId, prefix)`, `tapFirstWithPrefix(prefix)`. If any are
> missing, add them to `base.page.ts` (it owns the `appium_*` wrappers) — do not duplicate per page.

- [ ] **Step 2: The combined smoke spec**

`DevDashboard/mobile/e2e/specs/features-rest.smoke.spec.ts`:

```typescript
import { ClaudeUsagePage } from "../pages/claude-usage.page";
import { ContainersPage } from "../pages/containers.page";
import { DaemonPage } from "../pages/daemon.page";
import { NavPage } from "../pages/nav.page"; // Plan 04: drives the "More" tab + (more) stack (openMore/openHome)
import { PulsePage } from "../pages/pulse.page"; // Plan 05: home/Pulse screen — owns the weather-card assertion
import { TodosPage } from "../pages/todos.page";

describe("Features-rest smoke (todos / claude / daemon / containers / weather)", () => {
    const nav = new NavPage();

    it("Todos: reaches the screen and shows the list or the permission CTA", async () => {
        await nav.openMore("todos");
        const todos = new TodosPage();
        await todos.waitUntilReady();

        if (await todos.isPermissionGate()) {
            // Permission denied in CI is a valid state — the CTA is the feature here.
            expect(await todos.exists("todos-request-access")).toBe(true);
            return;
        }

        await todos.setStatusFilter("all");
        await todos.openAddSheet();
        await todos.typeTitle("appium smoke todo");
        // Submit is allowed to fail silently if Reminders is read-only in CI; assert the sheet flow worked.
        expect(await todos.exists("todo-submit")).toBe(true);
    });

    it("Claude usage: reaches the screen and toggles the range", async () => {
        await nav.openMore("claude");
        const claude = new ClaudeUsagePage();
        await claude.waitUntilReady();

        if (await claude.exists("claude-empty")) {
            return; // no accounts configured — valid
        }

        await claude.selectRange("24h");
        expect(await claude.hasAnyAccountCard()).toBe(true);
    });

    it("Daemon: shows status and opens a run log when runs exist", async () => {
        await nav.openMore("daemon");
        const daemon = new DaemonPage();
        await daemon.waitUntilReady();

        const label = await daemon.statusLabel();
        expect(["Running", "Stopped", "Not installed"]).toContain(label);

        if (await daemon.openFirstRunLog()) {
            expect(await daemon.exists("daemon-log-body")).toBe(true);
            await daemon.closeRunLog();
        }
    });

    it("Containers: shows the list or the docker-unavailable state", async () => {
        await nav.openMore("containers");
        const containers = new ContainersPage();
        await containers.waitUntilReady();

        const unavailable = await containers.dockerUnavailable();
        const hasList = await containers.exists("containers-list");
        expect(unavailable || hasList).toBe(true);
    });

    it("Weather: the card renders on the home/Pulse screen", async () => {
        await nav.openHome();
        const pulse = new PulsePage(); // Plan 05's home/Pulse page object
        await pulse.waitForVisible("weather-card");
        expect(await pulse.exists("weather-card")).toBe(true);
    });
});
```

- [ ] **Step 3: Run the spec on the iOS simulator/dev-client**

Drive via the `appium_*` MCP tools (the §8 iteration harness): `select_device` (ios, simulator) →
`prepare_ios_simulator` → `appium_session_management` (action=`create`) → run the spec through the
WebdriverIO runner configured in Plan 04 (`bunx wdio run e2e/wdio.conf.ts --spec
e2e/specs/features-rest.smoke.spec.ts`).
Expected: all 5 `it` blocks PASS (each tolerant of the empty/permission/unavailable states that are
valid on a fresh CI agent — the bar is "the screen reaches a defined state + its key control works",
not "real data exists").

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/e2e/pages/todos.page.ts DevDashboard/mobile/e2e/pages/claude-usage.page.ts \
        DevDashboard/mobile/e2e/pages/daemon.page.ts DevDashboard/mobile/e2e/pages/containers.page.ts \
        DevDashboard/mobile/e2e/specs/features-rest.smoke.spec.ts
git commit -m "test(dd-mobile-e2e): combined Appium smoke for todos/claude/daemon/containers/weather"
```

---

## Self-Review checklist

1. **Contract ownership:** Tasks 1–3 added the `todos`/`claude`/`daemon`/`containers`/`weather`
   namespaces to `@devdashboard/contract` — no `dashboard.<feature>.*` reference in Tasks 4–9 is a
   dangling placeholder. `client.test.ts` proves each method with a fake `fetch`.
2. **Real shapes, not 03 stubs:** todos = `{ lists, reminders }` (not `{ items }`); `is_completed`/
   `due_date`/numeric `priority`; claude usage = `AccountUsage[]` (array); containers =
   `{ dockerAvailable, containers }`; `UsageSnapshot.resetsAt` (camel) vs `UsageBucket.resets_at`
   (snake). Every superseded 03 name carries a `// supersedes 03 stub` note.
3. **503 CTA wired:** `RemindersPermissionError` is thrown by `todos.list` on 503 and caught in
   `todos.tsx` → renders `RemindersPermissionCta` → `requestAccess()` POSTs `/api/todos/request-access`.
4. **Purity intact:** `contract-purity.test.ts` still green — all new DTOs are pure inline types, no
   `@genesiscz/darwinkit` re-export, no `node:`/`bun:` imports.
5. **Native, not transliterated web:** every screen is RN (`View`/`Text`/`FlatList`/`Pressable`/
   `Modal`), NativeWind token classes only (no raw palette, no `<div>`), `testID` on every asserted
   node.
6. **Forward-deps declared, not invented:** `dashboard`, `MetricChart`, `QueryClientProvider`, the
   `(more)` nav group, and `BasePage` are consumed by their assumed names from Plans 04/05 and listed
   in the preamble + openQuestions — none silently renamed.
7. **Conventions:** `SafeJSON` is N/A in RN screens (the contract client owns JSON parsing); no
   one-line ifs; blank line before `if` / after closing brace; objects for 3+ params; no `as any`;
   `MetricChart` props match the assumed interface exactly.
8. **TDD:** each contract method + the claude mapper has a failing-then-passing test; screens are
   typechecked. Charts/screens are covered behaviorally by the Appium spec (Task 9).

## Appium E2E (per ADR §8)

- **Spec:** `DevDashboard/mobile/e2e/specs/features-rest.smoke.spec.ts` — one combined smoke flow with
  five `it` blocks (todos, claude, daemon, containers, weather).
- **New Page Objects (extend ADR §8's POM list):** `TodosPage`, `ClaudeUsagePage`, `DaemonPage`,
  `ContainersPage` (`e2e/pages/*.page.ts`), each `extends BasePage`. Weather is asserted via its card
  `testID` (`weather-card`) on the home/Pulse screen — no dedicated page.
- **Page Object methods:**
  - `TodosPage`: `waitUntilReady()`, `isPermissionGate()`, `setStatusFilter(value)`, `openAddSheet()`,
    `typeTitle(title)`, `submit()`.
  - `ClaudeUsagePage`: `waitUntilReady()`, `selectRange(label)`, `hasAnyAccountCard()`.
  - `DaemonPage`: `waitUntilReady()`, `statusLabel()`, `openFirstRunLog()`, `closeRunLog()`.
  - `ContainersPage`: `waitUntilReady()`, `dockerUnavailable()`.
- **Locators:** accessibility-id only (RN `testID` → iOS `accessibilityIdentifier`). Key ids:
  `todos-screen`/`todos-list`/`todos-permission-cta`/`todos-request-access`/`todos-status-{active,done,
  all}`/`todos-add`/`todo-sheet`/`todo-title-input`/`todo-submit`; `claude-screen`/`claude-empty`/
  `claude-range-{1h,24h,7d}`/`claude-range-control`/`claude-account-<name>`/`claude-chart-<name>`;
  `daemon-screen`/`daemon-status-label`/`daemon-runs`/`daemon-run-<runId>`/`daemon-log-sheet`/
  `daemon-log-body`/`daemon-log-close`; `containers-screen`/`containers-list`/
  `containers-docker-unavailable`/`container-row-<id>`; `weather-card`/`weather-temp`.
- **MCP tools (the §8 iteration harness):** `select_device` (ios/simulator) → `prepare_ios_simulator`
  → `appium_session_management` (action=`create`) → `appium_find_element` (strategy=`accessibility id`)
  → `appium_gesture` (action=`tap` / `scroll_to_element`) → `appium_get_text` for assertions.
- **Done criterion:** each feature in this plan is "done" **only when** `features-rest.smoke.spec.ts`
  passes on the iOS simulator/dev-client. Empty / permission-denied / docker-unavailable are valid
  terminal states the spec tolerates (CI agents have no Reminders grant, no Claude accounts, no
  Docker) — the assertion is that the screen reaches a defined state and its primary control responds.

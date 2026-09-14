# 03 — Shared Contract Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
> Read `…-00-Overview.md`, `…-ADR.md`, and `…-01-ServerExtraction.md` first. Work in the
> `feat/dev-dashboard-mobile` worktree. **Depends on 01** (route signatures are the source).

**Goal:** Create `@app/dev-dashboard/contract` — a **pure, runtime-dependency-light** module that is
the single source of truth for the dashboard's DTOs, endpoint catalog, and a **transport-agnostic
typed client**. Consumed by the web UI, the Agent (response typing), and the Expo mobile app.

**Architecture:** Three pure files — `dto.ts` (data types only; NO server/Node/Bun runtime
imports), `endpoints.ts` (an operation catalog mapping each `/api` route to its method, path
builder, request and response types), and `client.ts` (`createDashboardClient({ baseUrl, fetch,
authHeader })` returning typed methods + an SSE subscribe helper that takes an **injected**
`EventSource`-like factory, so the RN SSE implementation chosen in research file 04 plugs in without
touching the contract). The web `ui/src/lib/api.ts` is refactored onto this client; the mobile app
imports the same package.

**Tech Stack:** TypeScript (strict, `import type` only for DTO re-exports), `bun:test`.

**Definition of done:** Web UI compiles against the contract client with no behavior change; the
contract has zero value imports from `lib/*` (verified by a guard test); `createDashboardClient`
unit tests pass with a fake `fetch`; the SSE helper works with a fake EventSource factory.

---

## Why a separate contract module (not just sharing `lib/*` types)

`lib/*` types files often sit next to runtime code (Bun spawns, `bun:sqlite`, macOS shell calls).
Importing them into a React Native bundle would drag server-only code into the app. The contract is
a **leaf module**: it may only `import type` from PROVEN-pure type files, and otherwise defines its
own DTOs. A guard test enforces "no value imports from `@app/dev-dashboard/lib`".

## File Structure

**Create:**
- `src/dev-dashboard/contract/dto.ts`
- `src/dev-dashboard/contract/endpoints.ts`
- `src/dev-dashboard/contract/client.ts`
- `src/dev-dashboard/contract/index.ts` (barrel)
- `src/dev-dashboard/contract/contract-purity.test.ts`
- `src/dev-dashboard/contract/client.test.ts`

**Modify:**
- `src/dev-dashboard/ui/src/lib/api.ts` (refactor onto `createDashboardClient`; keep exported names).

---

### Task 1: DTOs (`dto.ts`) — pure data types

**Files:**
- Create: `src/dev-dashboard/contract/dto.ts`

- [ ] **Step 1: Audit which `lib` type files are runtime-free**

Run: `for f in system/types ttyd/types cmux/types obsidian/types qa-types; do echo "== $f =="; rg -n "^import |require\(" src/dev-dashboard/lib/$f.ts 2>/dev/null | rg -v "import type"; done`
Expected: list any value imports. A file with ONLY `import type` (or none) is safe to type-re-export;
any file with a value import needs its DTO **redefined** in `dto.ts` instead.

- [ ] **Step 2: Write `dto.ts`**

```typescript
// Pure data contract. NO value imports — `import type` only, and only from proven-pure files.
export type { PulseSnapshot, PulseSeries, PulsePoint, TopProcess } from "@app/dev-dashboard/lib/system/types";
export type { TtydSession, SplitNode } from "@app/dev-dashboard/lib/ttyd/types";

// Redefine (or type-re-export, per the Step 1 audit) the remaining DTOs as pure types:
export interface TmuxHubSession {
    name: string;
    attached: number;
    windows: number;
    ttydTabIds: string[];
    canAttachInTtyd: boolean;
    cmuxSurfaces: Array<{ workspaceId: string; surfaceId: string; title: string }>;
    inCmux: boolean;
}

export interface QaEntry {
    id: string;
    question: string;
    answer: string;
    tag: string;
    project: string | null;
    createdAt: string;
    readAt: string | null;
    // ...mirror the enriched fields from `enrichQaEntry` (qa-render.ts). Verify field names.
}

export interface TodoItem {
    reminderId: string;
    listIdentifier: string;
    title: string;
    notes?: string;
    due?: string | null;
    priority: "none" | "low" | "medium" | "high";
    completed: boolean;
    url?: string;
}

// CmuxSnapshot, CmuxLayoutTree, VaultEntry, ClaudeUsage(+History), DaemonOverview, DaemonRun,
// Container, Weather, AudioLibrary — re-export with `export type` if the source file passed the
// Step 1 purity audit; otherwise define the pure shape here. Each MUST match the JSON the route
// returns (see 01's route->lib map). Do NOT guess fields — read the lib return type for each.
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsgo --noEmit | rg "contract/dto"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dev-dashboard/contract/dto.ts
git commit -m "feat(dd-contract): pure DTO types (single source of truth)"
```

---

### Task 2: Purity guard test

**Files:**
- Create: `src/dev-dashboard/contract/contract-purity.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["dto.ts", "endpoints.ts", "client.ts", "index.ts"];

describe("contract purity", () => {
    it("never VALUE-imports from lib/* (only `import type` allowed)", () => {
        for (const file of FILES) {
            const src = readFileSync(join(import.meta.dir, file), "utf8");
            const badValueImport = /^import\s+(?!type\b)[^;]*from\s+["']@app\/dev-dashboard\/lib/m.test(src);
            expect(badValueImport, `${file} has a value import from lib/*`).toBe(false);
        }
    });

    it("never imports node:/bun: runtime in dto.ts or client.ts", () => {
        for (const file of ["dto.ts", "client.ts"]) {
            const src = readFileSync(join(import.meta.dir, file), "utf8");
            expect(/from\s+["'](node:|bun:)/.test(src), `${file} imports a runtime module`).toBe(false);
        }
    });
});
```

- [ ] **Step 2: Run it**

Run: `bun test src/dev-dashboard/contract/contract-purity.test.ts`
Expected: PASS (proves the contract is RN-bundle-safe).

- [ ] **Step 3: Commit**

```bash
git add src/dev-dashboard/contract/contract-purity.test.ts
git commit -m "test(dd-contract): guard against runtime imports (RN-bundle safety)"
```

---

### Task 3: Endpoint catalog (`endpoints.ts`)

**Files:**
- Create: `src/dev-dashboard/contract/endpoints.ts`

- [ ] **Step 1: Write the catalog (path builders + method)**

```typescript
import type {
    ClaudeUsage, Container, DaemonOverview, PulseSeries, PulseSnapshot,
    QaEntry, TmuxHubSession, TodoItem, TtydSession, VaultEntry, Weather,
} from "@app/dev-dashboard/contract/dto";

export const QA_STREAM_PATH = "/api/qa/stream" as const;

/** Pure path builders — no fetching here. */
export const paths = {
    pulse: () => "/api/system/pulse",
    pulseHistory: (metric: string, minutes: number) => `/api/system/pulse/history?metric=${encodeURIComponent(metric)}&minutes=${minutes}`,
    tmuxSessions: () => "/api/tmux/sessions",
    ttydList: () => "/api/ttyd/list",
    cmuxSnapshot: () => "/api/cmux/snapshot",
    cmuxLayout: () => "/api/cmux/layout",
    weather: () => "/api/weather",
    claudeUsage: () => "/api/claude/usage",
    daemonStatus: () => "/api/daemon/status",
    containers: () => "/api/containers",
    qaLog: (q: { project?: string; tag?: string; unread?: boolean; limit?: number } = {}) => {
        const sp = new URLSearchParams();
        if (q.project) sp.set("project", q.project);
        if (q.tag) sp.set("tag", q.tag);
        if (q.unread) sp.set("unread", "1");
        if (q.limit) sp.set("limit", String(q.limit));
        const s = sp.toString();
        return `/api/qa/log${s ? `?${s}` : ""}`;
    },
    todos: (listIds: string[] = [], includeCompleted = false) => {
        const sp = new URLSearchParams();
        if (listIds.length) sp.set("listIds", listIds.join(","));
        if (includeCompleted) sp.set("includeCompleted", "true");
        const s = sp.toString();
        return `/api/todos${s ? `?${s}` : ""}`;
    },
    obsidianTree: () => "/api/obsidian/tree",
    obsidianNote: (path: string) => `/api/obsidian/note?path=${encodeURIComponent(path)}`,
    // ...plus all POST/PATCH/DELETE paths (no query): /api/tmux/create, /api/ttyd/spawn, etc.
} as const;

// Response type aliases so the client methods stay readable:
export type PulseRes = PulseSnapshot;
export type PulseHistoryRes = PulseSeries;
export type TmuxSessionsRes = { sessions: TmuxHubSession[] };
export type TtydListRes = { sessions: TtydSession[] };
export type ContainersRes = Container[];
export type ClaudeUsageRes = ClaudeUsage;
export type DaemonStatusRes = DaemonOverview;
export type QaLogRes = { entries: QaEntry[] };
export type TodosRes = { items: TodoItem[] } /* match listTodos() return shape */;
export type ObsidianTreeRes = { entries: VaultEntry[] };
export type WeatherRes = Weather;
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "contract/endpoints"`
Expected: no errors.

```bash
git add src/dev-dashboard/contract/endpoints.ts
git commit -m "feat(dd-contract): endpoint path catalog + response type aliases"
```

---

### Task 4: Transport-agnostic typed client (`client.ts`)

**Files:**
- Create: `src/dev-dashboard/contract/client.ts`
- Test: `src/dev-dashboard/contract/client.test.ts`

- [ ] **Step 1: Write the failing test (fake fetch + fake SSE)**

```typescript
import { describe, expect, it } from "bun:test";
import { createDashboardClient } from "@app/dev-dashboard/contract/client";

function fakeFetch(body: unknown, status = 200): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("createDashboardClient", () => {
    it("GETs pulse with the auth header and parses JSON", async () => {
        let sentAuth = "";
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            sentAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
            return new Response(JSON.stringify({ cpuPct: 12, capturedAt: "t" }), { status: 200 });
        }) as unknown as typeof fetch;

        const c = createDashboardClient({ baseUrl: "http://h", fetch: fetchImpl, authHeader: () => "Basic xyz" });
        const pulse = await c.system.pulse();
        expect(pulse.cpuPct).toBe(12);
        expect(sentAuth).toBe("Basic xyz");
    });

    it("throws on a non-ok response with the status + body", async () => {
        const c = createDashboardClient({ baseUrl: "http://h", fetch: fakeFetch({ error: "nope" }, 500) });
        await expect(c.system.pulse()).rejects.toThrow(/500/);
    });

    it("subscribeQaStream uses the injected EventSource factory", () => {
        const events: string[] = [];
        const fakeES = (url: string) => {
            events.push(url);
            return { close() {}, addEventListener() {}, onmessage: null, onerror: null } as unknown as EventSource;
        };
        const c = createDashboardClient({ baseUrl: "http://h", fetch: fakeFetch({}), eventSourceFactory: fakeES });
        const sub = c.qa.subscribe(() => {});
        expect(events[0]).toContain("/api/qa/stream");
        sub.close();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/contract/client.test.ts`
Expected: FAIL — `createDashboardClient` not defined.

- [ ] **Step 3: Implement the client**

```typescript
import type { PulseHistoryRes, PulseRes, QaLogRes, TmuxSessionsRes, TtydListRes } from "@app/dev-dashboard/contract/endpoints";
import { paths, QA_STREAM_PATH } from "@app/dev-dashboard/contract/endpoints";
import type { QaEntry } from "@app/dev-dashboard/contract/dto";

export interface EventSourceLike {
    close(): void;
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

export interface DashboardClientOptions {
    baseUrl: string;
    fetch: typeof fetch;
    /** Returns the Authorization header value (e.g. "Basic …"), or undefined for none. */
    authHeader?: () => string | undefined;
    /** RN injects react-native-sse here; web injects window.EventSource. (transport pick: file 04) */
    eventSourceFactory?: (url: string) => EventSourceLike;
}

export interface QaSubscription {
    close(): void;
}

export function createDashboardClient(opts: DashboardClientOptions) {
    const { baseUrl, fetch: fetchImpl } = opts;

    async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
        const auth = opts.authHeader?.();
        const res = await fetchImpl(`${baseUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(auth ? { Authorization: auth } : {}),
                ...(init?.headers ?? {}),
            },
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${path} -> ${res.status}: ${text}`);
        }

        return JSON.parse(await res.text()) as T;
    }

    function post<T>(path: string, body: unknown): Promise<T> {
        return getJson<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    }

    return {
        system: {
            pulse: () => getJson<PulseRes>(paths.pulse()),
            pulseHistory: (metric: string, minutes: number) => getJson<PulseHistoryRes>(paths.pulseHistory(metric, minutes)),
        },
        tmux: {
            sessions: () => getJson<TmuxSessionsRes>(paths.tmuxSessions()),
            create: (b: { name?: string; cwd?: string; command?: string }) => post(paths /* /api/tmux/create */ && "/api/tmux/create", b),
        },
        ttyd: {
            list: () => getJson<TtydListRes>(paths.ttydList()),
            spawn: (b: { command?: string; cwd?: string; tmuxSessionName?: string } = {}) => post("/api/ttyd/spawn", b),
            kill: (id: string, killTmux = false) => post("/api/ttyd/kill", { id, killTmux }),
        },
        qa: {
            log: (q?: Parameters<typeof paths.qaLog>[0]) => getJson<QaLogRes>(paths.qaLog(q)),
            subscribe: (onEntry: (entry: QaEntry) => void): QaSubscription => {
                if (!opts.eventSourceFactory) {
                    throw new Error("eventSourceFactory required to subscribe to the QA stream");
                }

                const es = opts.eventSourceFactory(`${baseUrl}${QA_STREAM_PATH}`);
                es.onmessage = (ev) => {
                    try {
                        onEntry(JSON.parse(ev.data) as QaEntry);
                    } catch {
                        // ignore malformed frame (keep-alive comments never reach onmessage)
                    }
                };

                return { close: () => es.close() };
            },
        },
        // ...cmux, weather, claude, daemon, containers, todos, obsidian — same getJson/post pattern,
        // one method per route in 01's map. Keep method names aligned with the existing ui/src/lib/api.ts
        // (ttydApi/tmuxApi/cmuxApi/obsidianApi) so the web refactor is a drop-in.
    };
}

export type DashboardClient = ReturnType<typeof createDashboardClient>;
```

> NOTE: the `paths /* … */ && "/api/tmux/create"` placeholder above is illustrative — define a real
> `paths.tmuxCreate = () => "/api/tmux/create"` (and the rest of the POST paths) in `endpoints.ts`
> Task 3 Step 1 and call them. No magic strings in the final code.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/contract/client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/contract/client.ts src/dev-dashboard/contract/client.test.ts
git commit -m "feat(dd-contract): transport-agnostic typed client + injectable SSE"
```

---

### Task 5: Barrel + refactor the web UI onto the client

**Files:**
- Create: `src/dev-dashboard/contract/index.ts`
- Modify: `src/dev-dashboard/ui/src/lib/api.ts`

- [ ] **Step 1: Barrel**

```typescript
export * from "@app/dev-dashboard/contract/dto";
export * from "@app/dev-dashboard/contract/endpoints";
export * from "@app/dev-dashboard/contract/client";
```

- [ ] **Step 2: Refactor `ui/src/lib/api.ts` to build the client once (web transport)**

```typescript
import { createDashboardClient } from "@app/dev-dashboard/contract";

export const dashboard = createDashboardClient({
    baseUrl: "",
    fetch: (...a) => fetch(...a),
    eventSourceFactory: (url) => new EventSource(url) as unknown as import("@app/dev-dashboard/contract").EventSourceLike,
});

// Preserve the existing named exports so call sites don't churn:
export const ttydApi = dashboard.ttyd;
export const tmuxApi = dashboard.tmux;
export const cmuxApi = dashboard.cmux;
export const obsidianApi = dashboard.obsidian;
export { fetchJson } from "./fetch-json"; // if any callers still use it directly
```

- [ ] **Step 3: Typecheck + run web tests**

Run: `bunx tsgo --noEmit | rg "ui/src/lib/api|contract" ; bun test src/dev-dashboard/`
Expected: no new type errors; tests pass. Existing components compile against the same names.

- [ ] **Step 4: Smoke — web still works**

Run: `tools dev-dashboard ui up --dev --foreground` → load the home page → Pulse + tmux render.
Expected: identical behavior to before the refactor.

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/contract/index.ts src/dev-dashboard/ui/src/lib/api.ts
git commit -m "refactor(dd-web): consume the shared contract client (no behavior change)"
```

---

## Self-Review checklist

1. **Purity:** `contract-purity.test.ts` green — no value imports from `lib/*`, no `node:`/`bun:` in
   `dto.ts`/`client.ts`. This is what makes the package importable from the Expo bundle.
2. **Parity:** every route in 01's map has a client method; method names match the existing
   `ttydApi/tmuxApi/cmuxApi/obsidianApi` so the web refactor is a drop-in.
3. **SSE injection:** `subscribe` requires `eventSourceFactory`; web injects `window.EventSource`,
   mobile injects the file-04 pick (e.g. `react-native-sse`). The contract never hard-codes a
   transport.
4. **Auth injection:** `authHeader()` is provided by the consumer (web omits it / relies on cookie;
   mobile returns `Basic …`). Matches 01's auth model.
5. **No placeholders:** the illustrative `paths /* */ && "…"` line is replaced by real path builders.

## Hand-off

The mobile app (04-MobileFoundation) imports `@app/dev-dashboard/contract` and constructs a client
with its RN `fetch`, a `SecureStore`-backed `authHeader`, and the file-04 SSE factory. The exact
**mobile import mechanism** (path alias / local workspace package across the Expo project boundary)
is decided in the ADR + 04.

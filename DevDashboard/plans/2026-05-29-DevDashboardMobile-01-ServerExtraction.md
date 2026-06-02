# 01 — DevDashboard Agent: Server Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax. **Read `…-00-Overview.md` and `…-ADR.md` first.** Work in the
> `feat/dev-dashboard-mobile` worktree.

**Goal:** Lift the HTTP routing out of `src/dev-dashboard/ui/vite-middleware.ts` into a
transport-agnostic handler **registry**, so the same `/api/*` contract can be served by (a) the
existing Vite middleware (web, unchanged behavior) and (b) a new standalone **DevDashboard Agent**
(`Bun.serve`) with no Vite dependency — without touching any `lib/*` business logic.

**Architecture:** A `Router` maps `{method, pathname}` → `RouteHandler(ctx) => RouteResult`.
`RouteContext` and `RouteResult` are framework-neutral (no Node `http` or `Connect` types leak in).
Two thin adapters translate between the registry and a transport: `nodeConnectAdapter` (wraps the
registry as Vite Connect middleware) and `bunServeFetch` (a `Bun.serve` `fetch` handler). Auth
becomes a registry-level guard refactored out of `requireDashboardAuth`, reusing `lib/auth.ts`
verbatim. Pollers (`startPolling`, `startPulsePolling`) move from module-load side effects into an
explicit `start()` the Agent owns. The macOS telemetry collector is wrapped behind a
`SystemCollector` interface so the product can add Linux/Windows later.

**Tech Stack:** Bun, TypeScript (strict), existing `@app/dev-dashboard/lib/*`, `bun:test`.

**Definition of done (M0):** `tools dev-dashboard ui up` still serves the web UI with identical
behavior; `tools dev-dashboard agent` serves `/api/*` standalone (no Vite) and `curl
localhost:<port>/api/system/pulse` returns the pulse snapshot; all existing dev-dashboard tests
remain green; new registry/router/adapter unit tests pass.

---

## File Structure

**Create:**
- `src/dev-dashboard/server/types.ts` — `RouteContext`, `RouteResult`, `RouteHandler`, `RouteDef`, `HttpMethod`.
- `src/dev-dashboard/server/router.ts` — `Router` (register + match + path params).
- `src/dev-dashboard/server/router.test.ts`
- `src/dev-dashboard/server/auth-guard.ts` — `decideApiAuth()` + `applyAuthResult()` (transport-neutral, reuses `lib/auth.ts`).
- `src/dev-dashboard/server/auth-guard.test.ts`
- `src/dev-dashboard/server/adapters/node-connect.ts` — Connect/Vite adapter.
- `src/dev-dashboard/server/adapters/node-connect.test.ts`
- `src/dev-dashboard/server/adapters/bun-serve.ts` — `Bun.serve` `fetch` adapter (HTTP + SSE + binary).
- `src/dev-dashboard/server/adapters/bun-serve.test.ts`
- `src/dev-dashboard/server/routes/{tmux,ttyd,cmux,system,weather,claude,daemon,containers,qa,todos,obsidian,share}.ts` — one registrar per feature.
- `src/dev-dashboard/server/registry.ts` — assembles all registrars + the auth guard; exposes `createDashboardRouter()` and `startBackgroundServices()`.
- `src/dev-dashboard/server/registry.test.ts`
- `src/dev-dashboard/server/collector/SystemCollector.ts` — interface + `MacSystemCollector` wrapping `lib/system/collector.ts`.
- `src/dev-dashboard/server/serve.ts` — `serveAgent({ port, host })`: `Bun.serve` mounting the router + `startFrontProxy` + `startBackgroundServices`.

**Modify:**
- `src/dev-dashboard/ui/vite-middleware.ts` — replace the giant `if`-chain with a delegation to `createDashboardRouter()` via `nodeConnectAdapter` (keep the existing `requireDashboardAuth` for the loopback/cookie semantics, now sourced from `auth-guard.ts`).
- `src/dev-dashboard/index.ts` — add a `dev-dashboard agent` subcommand calling `serveAgent`.

**Untouched (consumed as-is):** everything under `src/dev-dashboard/lib/*` except the two
module-load polling side-effects, which move into `startBackgroundServices()`.

---

### Task 1: Define the transport-neutral server contract types

**Files:**
- Create: `src/dev-dashboard/server/types.ts`

- [ ] **Step 1: Write the types**

```typescript
import type { SystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS";

/** Everything a handler needs, with zero coupling to Node http / Connect / Bun. */
export interface RouteContext {
    method: HttpMethod;
    /** Pathname only, no query (e.g. "/api/system/pulse"). */
    pathname: string;
    /** Parsed query string. */
    query: URLSearchParams;
    /** Path params captured by the matched pattern (e.g. { slug }). */
    params: Record<string, string>;
    /** Lowercased request headers. */
    headers: Record<string, string>;
    /** Lazily reads + strict-parses the JSON body. Throws on invalid JSON. */
    readJson: <T>() => Promise<T>;
    /** Injected services (lets routes stay pure + testable). */
    services: RouteServices;
}

export interface RouteServices {
    collector: SystemCollector;
}

/** A handler returns a declarative result; adapters serialize it per transport. */
export type RouteResult =
    | { kind: "json"; status: number; body: unknown }
    | { kind: "text"; status: number; body: string; contentType?: string }
    | { kind: "binary"; status: number; body: Uint8Array; contentType: string; headers?: Record<string, string> }
    | { kind: "sse"; start: (emit: SseEmitter) => SseHandle }
    | { kind: "raw"; status: number; body: string; contentType: string; headers?: Record<string, string> };

export interface SseEmitter {
    /** Write one `data:` event. */
    data: (payload: string) => void;
    /** Write a raw line (e.g. a comment keep-alive ": ping"). */
    comment: (text: string) => void;
}

export interface SseHandle {
    /** Called when the client disconnects; clean up timers/subscriptions. */
    close: () => void;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

export interface RouteDef {
    method: HttpMethod;
    /** Express-style pattern; supports ":param" segments (e.g. "/share/:slug"). */
    pattern: string;
    handler: RouteHandler;
    /** When true, the adapter must NOT apply a short upstream/read timeout (SSE). */
    longLived?: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsgo --noEmit | rg "server/types"`
Expected: no errors referencing `server/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/dev-dashboard/server/types.ts
git commit -m "feat(dd-agent): transport-neutral route contract types"
```

---

### Task 2: Implement the Router (register + match + path params)

**Files:**
- Create: `src/dev-dashboard/server/router.ts`
- Test: `src/dev-dashboard/server/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { Router } from "@app/dev-dashboard/server/router";
import type { RouteResult } from "@app/dev-dashboard/server/types";

const ok = (): RouteResult => ({ kind: "json", status: 200, body: {} });

describe("Router", () => {
    it("matches an exact static route by method + path", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/api/system/pulse", handler: ok });
        const m = r.match("GET", "/api/system/pulse");
        expect(m).not.toBeNull();
        expect(m?.params).toEqual({});
    });

    it("captures a :param segment", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/share/:slug", handler: ok });
        const m = r.match("GET", "/share/abc123");
        expect(m?.params).toEqual({ slug: "abc123" });
    });

    it("does not match a :param across a slash", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/share/:slug", handler: ok });
        expect(r.match("GET", "/share/abc/def")).toBeNull();
    });

    it("distinguishes methods on the same path", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/api/todos", handler: ok });
        r.add({ method: "POST", pattern: "/api/todos", handler: ok });
        expect(r.match("DELETE", "/api/todos")).toBeNull();
        expect(r.match("POST", "/api/todos")).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/dev-dashboard/server/router.test.ts`
Expected: FAIL — `Router` is not defined / module missing.

- [ ] **Step 3: Implement the Router**

```typescript
import type { HttpMethod, RouteDef } from "@app/dev-dashboard/server/types";

interface CompiledRoute {
    def: RouteDef;
    regex: RegExp;
    paramNames: string[];
}

export interface RouteMatch {
    def: RouteDef;
    params: Record<string, string>;
}

function compile(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const source = pattern
        .split("/")
        .map((seg) => {
            if (seg.startsWith(":")) {
                paramNames.push(seg.slice(1));
                return "([^/]+)";
            }

            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");

    return { regex: new RegExp(`^${source}$`), paramNames };
}

export class Router {
    private readonly routes: CompiledRoute[] = [];

    add(def: RouteDef): this {
        const { regex, paramNames } = compile(def.pattern);
        this.routes.push({ def, regex, paramNames });

        return this;
    }

    addAll(defs: RouteDef[]): this {
        for (const def of defs) {
            this.add(def);
        }

        return this;
    }

    match(method: string, pathname: string): RouteMatch | null {
        for (const route of this.routes) {
            if (route.def.method !== method) {
                continue;
            }

            const m = route.regex.exec(pathname);

            if (!m) {
                continue;
            }

            const params: Record<string, string> = {};
            route.paramNames.forEach((name, i) => {
                params[name] = decodeURIComponent(m[i + 1] ?? "");
            });

            return { def: route.def, params };
        }

        return null;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/server/router.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/router.ts src/dev-dashboard/server/router.test.ts
git commit -m "feat(dd-agent): route registry with method + path-param matching"
```

---

### Task 3: Transport-neutral auth guard (refactor of `requireDashboardAuth`)

> Extracts the exact decision logic from `vite-middleware.ts:115-176` into a pure function so both
> adapters share it. Reuses `lib/auth.ts` verbatim. The cookie-minting behavior (Basic → Set-Cookie)
> is preserved because the ttyd WS handshake relies on the `dd_session` cookie.

**Files:**
- Create: `src/dev-dashboard/server/auth-guard.ts`
- Test: `src/dev-dashboard/server/auth-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { createBasicAuthCredentials, makeBasicAuthHeader } from "@app/dev-dashboard/lib/auth";
import { decideApiAuth } from "@app/dev-dashboard/server/auth-guard";

const { auth } = createBasicAuthCredentials({ username: "u", password: "p" });
const provision = { auth, generatedPassword: null };

describe("decideApiAuth", () => {
    it("allows a genuine loopback origin (header set by proxy)", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/api/system/pulse", headers: { "x-dd-local-origin": "1" }, provision });
        expect(d.decision).toBe("allow");
    });

    it("allows a /share/<slug> GET without auth", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/share/tok", headers: {}, provision });
        expect(d.decision).toBe("allow");
    });

    it("allows + mints a cookie for a valid Basic header", () => {
        const d = decideApiAuth({
            method: "GET",
            pathname: "/api/system/pulse",
            headers: { authorization: makeBasicAuthHeader({ username: "u", password: "p" }) },
            provision,
        });
        expect(d.decision).toBe("allow");
        expect(d.setCookie).toBeString();
    });

    it("denies a missing/invalid credential", () => {
        const d = decideApiAuth({ method: "GET", pathname: "/api/system/pulse", headers: {}, provision });
        expect(d.decision).toBe("deny");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/server/auth-guard.test.ts`
Expected: FAIL — `decideApiAuth` not defined.

- [ ] **Step 3: Implement the guard**

```typescript
import type { DashboardAuthProvision } from "@app/dev-dashboard/config";
import {
    buildSessionCookie,
    type CompleteDashboardAuthConfig,
    isCompleteAuthConfig,
    issueSessionToken,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";

const SHARE_BYPASS_RE = /^\/share\/[^/]+$/;

export interface AuthInput {
    method: string;
    pathname: string;
    headers: Record<string, string>;
    provision: DashboardAuthProvision;
    /** true when the request arrived over the HTTPS tunnel (sets Secure on the cookie). */
    secure?: boolean;
}

export interface AuthResult {
    decision: "allow" | "deny" | "unconfigured";
    /** When set, the adapter must emit this as a Set-Cookie header. */
    setCookie?: string;
}

/** Pure mirror of requireDashboardAuth's decision matrix (vite-middleware.ts:115). */
export function decideApiAuth(input: AuthInput): AuthResult {
    const { method, pathname, headers, provision } = input;

    if (method === "GET" && SHARE_BYPASS_RE.test(pathname)) {
        return { decision: "allow" };
    }

    if (headers[LOCAL_ORIGIN_HEADER] === "1") {
        return { decision: "allow" };
    }

    if (!provision.auth.enabled) {
        return { decision: "allow" };
    }

    if (!isCompleteAuthConfig(provision.auth)) {
        return { decision: "unconfigured" };
    }

    const auth: CompleteDashboardAuthConfig = provision.auth;

    if (verifySessionToken(headers.cookie ?? null, auth)) {
        return { decision: "allow" };
    }

    if (verifyBasicAuthHeader(headers.authorization ?? null, auth)) {
        return { decision: "allow", setCookie: buildSessionCookie(issueSessionToken(auth), { secure: input.secure === true }) };
    }

    return { decision: "deny" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/server/auth-guard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/auth-guard.ts src/dev-dashboard/server/auth-guard.test.ts
git commit -m "feat(dd-agent): transport-neutral API auth guard (reuses lib/auth)"
```

---

### Task 4: `SystemCollector` interface + macOS implementation

> Wraps `lib/system/collector.ts` so the product can add Linux/Windows collectors later without
> touching routes. No behavior change today.

**Files:**
- Create: `src/dev-dashboard/server/collector/SystemCollector.ts`

- [ ] **Step 1: Write the interface + macOS impl**

```typescript
import { collectPulse } from "@app/dev-dashboard/lib/system/collector";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";

export interface SystemCollector {
    readonly platform: "macos" | "linux" | "windows";
    collect(): Promise<PulseSnapshot>;
}

export class MacSystemCollector implements SystemCollector {
    readonly platform = "macos" as const;

    collect(): Promise<PulseSnapshot> {
        return collectPulse();
    }
}

export function defaultSystemCollector(): SystemCollector {
    // Product roadmap: branch on process.platform for linux/windows collectors.
    return new MacSystemCollector();
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsgo --noEmit | rg "collector/SystemCollector"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/dev-dashboard/server/collector/SystemCollector.ts
git commit -m "feat(dd-agent): SystemCollector interface (macOS impl wraps collectPulse)"
```

---

### Task 5: Feature route registrars — pattern + full migration map

> Each registrar returns `RouteDef[]` whose handlers call the SAME `lib/*` functions the
> middleware calls today. Behavior is byte-identical; only the transport plumbing changes.
> Below is ONE complete registrar (system) as the canonical pattern, then the exhaustive
> route→lib map every other registrar must implement the same way.

**Files:**
- Create: `src/dev-dashboard/server/routes/system.ts` (shown in full)
- Create the other 11 registrars following the identical pattern.

- [ ] **Step 1: Write `routes/system.ts` (canonical pattern, full code)**

```typescript
import { getCachedPulse, getSeries } from "@app/dev-dashboard/lib/system/poller";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function systemRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/system/pulse",
            handler: () => ({ kind: "json", status: 200, body: getCachedPulse() ?? { capturedAt: null } }),
        },
        {
            method: "GET",
            pattern: "/api/system/pulse/history",
            handler: (ctx) => {
                const metric = ctx.query.get("metric") ?? "cpu";
                const minutes = Number.parseInt(ctx.query.get("minutes") ?? "30", 10);

                return { kind: "json", status: 200, body: getSeries(metric, Number.isFinite(minutes) ? minutes : 30) };
            },
        },
    ];
}
```

- [ ] **Step 2: Write a registrar test (system) and run it**

```typescript
import { describe, expect, it } from "bun:test";
import { systemRoutes } from "@app/dev-dashboard/server/routes/system";

describe("systemRoutes", () => {
    it("registers pulse + history with the right methods/patterns", () => {
        const defs = systemRoutes();
        const paths = defs.map((d) => `${d.method} ${d.pattern}`);
        expect(paths).toContain("GET /api/system/pulse");
        expect(paths).toContain("GET /api/system/pulse/history");
    });
});
```

Run: `bun test src/dev-dashboard/server/routes/system.test.ts`
Expected: PASS.

- [ ] **Step 3: Implement the remaining registrars using this EXACT route→lib map**

> Every row: `<METHOD> <pattern>` → call this `lib` function with these inputs, wrap the return in
> the matching `RouteResult`. POST/PATCH/DELETE bodies come from `await ctx.readJson<T>()`. Wrap
> handler bodies in try/catch and return `{ kind: "json", status: 500, body: { error } }` on throw,
> mirroring today's middleware (status codes noted where non-500).

`routes/tmux.ts`
- `GET /api/tmux/sessions` → `enrichSessionsForHub(listTmuxSessions(), await listTtyd(), cmuxBySession)` where `cmuxBySession` is built from `fetchCmuxFullLayout()` + `indexCmuxSurfacesByTmuxSession` (copy the try/catch enrichment block verbatim from `vite-middleware.ts:188-201`).
- `POST /api/tmux/create` `{name?,cwd?,command?}` → `createStandaloneTmuxSession(body)`.
- `POST /api/tmux/rename` `{from,to}` → `{ sessionName: await renameTmuxSessionInHub(from,to) }`.

`routes/ttyd.ts`
- `GET /api/ttyd/list` → `{ sessions: await listTtyd() }`.
- `POST /api/ttyd/spawn` `{command?,cwd?,tmuxSessionName?}` → `{ session: await spawnTtyd({command,cwd,attachTmuxSession:tmuxSessionName}) }`; on error map `statusCode===409` → 409.
- `POST /api/ttyd/kill` `{id,killTmux?}` → `{ ok: await killTtyd(id,{killTmux:killTmux===true}) }`.
- `POST /api/ttyd/rename` `{id,name}` → `{ ok: await renameTtyd(id,name) }`.

`routes/cmux.ts`
- `GET /api/cmux/snapshot` → `{ snapshot: getCachedSnapshot() }`.
- `GET /api/cmux/layout` → `{ layout: await fetchCmuxFullLayout() }`.
- `POST /api/cmux/create-terminal` `{cwd?}` → `{ result: await createDevDashboardTerminal({cwd}) }`.
- `POST /api/cmux/create-workspace` `{windowId,name?,cwd?}` → `{ result: await createCmuxWorkspace(body) }`.
- `POST /api/cmux/send-session` `{tmuxSessionName,target,cwd?}` → `{ result: await sendTmuxSessionToCmux(body) }`.
- `POST /api/cmux/remove-session` `{tmuxSessionName}` → `{ removed: await removeTmuxSessionFromCmux(name) }`.
- `POST /api/cmux/attach` `{workspaceId,paneId}` → `await focusCmuxPane(body); { ok: true }`.
- `POST /api/cmux/rename` `{workspaceId,surfaceId?,title}` → `renameCmuxSurface` if `surfaceId` else `renameCmuxWorkspace`; `{ ok: true }`.

`routes/weather.ts`
- `GET /api/weather` → `await fetchWeather((await getConfig()).weatherCoords)`.

`routes/claude.ts`
- `GET /api/claude/usage` → `await getCurrentUsage()`.
- `GET /api/claude/usage/history` (query `account,buckets,bucket,minutes`) → `getUsageHistoryMulti(...)` when `buckets` present else `getUsageHistory(...)` (copy parsing from `vite-middleware.ts:414-435`).

`routes/daemon.ts`
- `GET /api/daemon/status` → `await getDaemonOverview()`.
- `GET /api/daemon/runs` (query `task,limit`) → `task ? getRecentRuns({task,limit}) : getAllRecentRuns(limit)`.
- `GET /api/daemon/runs/log` (query `logFile`, 400 if missing) → `getRunLog(logFile)`.

`routes/containers.ts`
- `GET /api/containers` → `await listContainers()`.

`routes/qa.ts`
- `GET /api/qa/log` (query `project,tag,unread,limit`) → open `openReadModel(defaultDbPath())`, `queryEntries`, map `enrichQaEntry`, **`db.close()` in finally** (bun:sqlite FD leak — keep this).
- `POST /api/qa/read` `{ids[],unread?}` → `markEntriesUnread|markEntriesRead`; `db.close()` finally.
- `GET /api/qa/audio-library` → `getAudioLibrary()`.
- `GET /api/qa/sound` (query `id`, 404 if unknown) → `{ kind: "binary", contentType: "audio/wav", body: resolveSoundBuffer(entry.choice), headers: { "Cache-Control": "public, max-age=3600" } }`.
- `POST /api/qa/config` `{sound?,soundVolume?}` → spawn `tools question config …` (copy verbatim).
- `GET /api/qa/stream` → **`{ kind: "sse", longLived: true, start }`** (Task 6 details the SSE handler; set `longLived: true` on the `RouteDef`).
- `POST /api/qa/save-to-obsidian` `{entryId,relativeDir,baseName,mode?,createDir?,includeFrontmatter?,includeQuestion?}` (400 if missing required, 404 if entry unknown) → `saveToObsidianUnique(...)`; `db.close()` finally.

`routes/todos.ts`
- `GET /api/todos` (query `listIds|lists,includeCompleted`) → `await listTodos(listIds,{includeCompleted})`; map Reminders-permission errors → **503** (copy the `RemindersPermissionError` detection block verbatim).
- `POST /api/todos/request-access` → `await requestTodosAccess()`.
- `POST /api/todos` `{title,listName?,due?,priority?,notes?}` → `await addTodo({...,listName:listName??"GenesisTools"})`.
- `POST /api/todos/complete` `{reminderId}` → `await completeTodo(reminderId); {ok:true}`.
- `PATCH /api/todos` `{reminderId,listIdentifier,title,notes?,due?,priority?,url?}` → `await updateTodo(body); {ok:true}`.
- `DELETE /api/todos` `{reminderId}` → `await deleteTodo(reminderId); {ok:true}`.

`routes/obsidian.ts`
- `GET /api/obsidian/tree` → `{ entries: await listVault(vault) }`.
- `POST /api/obsidian/mkdir` `{relativeDir}` (400 if blank) → `await mkdirInVault(vault, dir); {ok:true, relativeDir}`.
- `GET /api/obsidian/note` (query `path`, 400 if missing, 404 on read error) → `{ source, html, publishedSlug }` (copy the wikilink-resolution block verbatim from `vite-middleware.ts:813-844`).
- `POST /api/obsidian/publish` `{path}` → `{ note: await publishNote(path) }`.
- `POST /api/obsidian/unpublish` `{slug}` → `await unpublishNote(slug); { remaining: await listPublished() }`.

`routes/share.ts`
- `GET /share/:slug` → `{ kind: "raw", contentType: "text/html; charset=utf-8", headers: { "Cache-Control": "no-store" }, body: renderSharePage(...) }` (copy the lookup + render block verbatim from `vite-middleware.ts:872-916`; 404 HTML when slug unknown). `params.slug` comes from the router.

- [ ] **Step 4: Run the full registrar test suite**

Run: `bun test src/dev-dashboard/server/routes/`
Expected: PASS for every registrar's shape test.

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/routes/
git commit -m "feat(dd-agent): all feature route registrars (route->lib map, behavior-identical)"
```

---

### Task 6: SSE result handling (qa/stream)

**Files:**
- Modify: `src/dev-dashboard/server/routes/qa.ts` (the `/api/qa/stream` handler)

- [ ] **Step 1: Implement the SSE handler returning a `kind: "sse"` result**

```typescript
import { createQaStream, todayLogFile } from "@app/dev-dashboard/lib/qa-sse";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { SafeJSON } from "@app/utils/json";
import type { RouteDef } from "@app/dev-dashboard/server/types";

const qaStreamRoute: RouteDef = {
    method: "GET",
    pattern: "/api/qa/stream",
    longLived: true,
    handler: () => ({
        kind: "sse",
        start: (emit) => {
            emit.comment(" qa stream open");
            const stream = createQaStream(todayLogFile(), (entry) => emit.data(SafeJSON.stringify(enrichQaEntry(entry))));
            const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

            return {
                close: () => {
                    clearInterval(keepAlive);
                    stream.close();
                },
            };
        },
    }),
};
```

- [ ] **Step 2: Commit**

```bash
git add src/dev-dashboard/server/routes/qa.ts
git commit -m "feat(dd-agent): qa SSE stream as a transport-neutral RouteResult"
```

---

### Task 7: Node/Connect adapter (Vite)

**Files:**
- Create: `src/dev-dashboard/server/adapters/node-connect.ts`
- Test: `src/dev-dashboard/server/adapters/node-connect.test.ts`

- [ ] **Step 1: Write the failing test (mock req/res, json + sse + binary)**

```typescript
import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { Router } from "@app/dev-dashboard/server/router";
import { handleWithRouter } from "@app/dev-dashboard/server/adapters/node-connect";

function mockRes() {
    const chunks: Buffer[] = [];
    const res: any = new PassThrough();
    res.statusCode = 200;
    res.headers = {} as Record<string, string>;
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
    res.on("data", (c: Buffer) => chunks.push(c));
    res.body = () => Buffer.concat(chunks).toString("utf8");

    return res;
}

describe("handleWithRouter (node)", () => {
    it("serializes a json result with status + content-type", async () => {
        const r = new Router().add({ method: "GET", pattern: "/x", handler: () => ({ kind: "json", status: 201, body: { a: 1 } }) });
        const req: any = { method: "GET", url: "/x", headers: { host: "localhost" } };
        const res = mockRes();
        const handled = await handleWithRouter(r, req, res, { services: fakeServices() });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(201);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.body()).toBe('{"a":1}');
    });

    it("returns false (calls next) for an unmatched route", async () => {
        const r = new Router();
        const req: any = { method: "GET", url: "/nope", headers: { host: "localhost" } };
        const handled = await handleWithRouter(r, req, mockRes(), { services: fakeServices() });
        expect(handled).toBe(false);
    });
});

function fakeServices() {
    return { collector: { platform: "macos", collect: async () => ({ capturedAt: null } as any) } };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/server/adapters/node-connect.test.ts`
Expected: FAIL — `handleWithRouter` not defined.

- [ ] **Step 3: Implement the adapter**

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { SafeJSON } from "@app/utils/json";
import type { Router } from "@app/dev-dashboard/server/router";
import type { RouteContext, RouteResult, RouteServices, SseEmitter } from "@app/dev-dashboard/server/types";

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8") || "{}";
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};

    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
            out[k.toLowerCase()] = v;
        } else if (Array.isArray(v)) {
            out[k.toLowerCase()] = v.join(", ");
        }
    }

    return out;
}

function writeResult(res: ServerResponse, result: RouteResult): void {
    if (result.kind === "json") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(SafeJSON.stringify(result.body));
        return;
    }

    if (result.kind === "text" || result.kind === "raw") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", result.contentType ?? "text/plain; charset=utf-8");
        if (result.kind === "raw" && result.headers) {
            for (const [k, v] of Object.entries(result.headers)) {
                res.setHeader(k, v);
            }
        }
        res.end(result.body);
        return;
    }

    if (result.kind === "binary") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", result.contentType);
        res.setHeader("Content-Length", String(result.body.length));
        for (const [k, v] of Object.entries(result.headers ?? {})) {
            res.setHeader(k, v);
        }
        res.end(Buffer.from(result.body));
        return;
    }

    // sse
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const emit: SseEmitter = {
        data: (payload) => res.write(`data: ${payload}\n\n`),
        comment: (text) => res.write(`:${text}\n\n`),
    };
    const handle = result.start(emit);
    const shutdown = () => handle.close();
    res.on("close", shutdown);
}

export async function handleWithRouter(
    router: Router,
    req: IncomingMessage,
    res: ServerResponse,
    opts: { services: RouteServices }
): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://dev-dashboard.local");
    const matched = router.match(req.method ?? "GET", url.pathname);

    if (!matched) {
        return false;
    }

    let cachedBody: string | undefined;
    const ctx: RouteContext = {
        method: (req.method ?? "GET") as RouteContext["method"],
        pathname: url.pathname,
        query: url.searchParams,
        params: matched.params,
        headers: lowerHeaders(req),
        readJson: async <T>() => {
            cachedBody ??= await readBody(req);
            return SafeJSON.parse(cachedBody, { strict: true }) as T;
        },
        services: opts.services,
    };

    const result = await matched.def.handler(ctx);
    writeResult(res, result);

    return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/server/adapters/node-connect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/adapters/node-connect.ts src/dev-dashboard/server/adapters/node-connect.test.ts
git commit -m "feat(dd-agent): node/connect adapter (json/text/binary/sse)"
```

---

### Task 8: Bun.serve adapter (standalone agent transport)

**Files:**
- Create: `src/dev-dashboard/server/adapters/bun-serve.ts`
- Test: `src/dev-dashboard/server/adapters/bun-serve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { Router } from "@app/dev-dashboard/server/router";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";

const services = { collector: { platform: "macos" as const, collect: async () => ({ capturedAt: null } as any) } };

describe("routerToResponse (bun)", () => {
    it("returns a JSON Response for a matched route", async () => {
        const r = new Router().add({ method: "GET", pattern: "/x", handler: () => ({ kind: "json", status: 200, body: { ok: true } }) });
        const res = await routerToResponse(r, new Request("http://h/x"), { services });
        expect(res?.status).toBe(200);
        expect(await res?.json()).toEqual({ ok: true });
    });

    it("returns null for an unmatched route (so the caller can 404 / fall through)", async () => {
        const res = await routerToResponse(new Router(), new Request("http://h/none"), { services });
        expect(res).toBeNull();
    });

    it("streams an SSE body", async () => {
        const r = new Router().add({
            method: "GET",
            pattern: "/s",
            longLived: true,
            handler: () => ({ kind: "sse", start: (emit) => { emit.data("hi"); return { close() {} }; } }),
        });
        const res = await routerToResponse(r, new Request("http://h/s"), { services });
        expect(res?.headers.get("content-type")).toContain("text/event-stream");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/server/adapters/bun-serve.test.ts`
Expected: FAIL — `routerToResponse` not defined.

- [ ] **Step 3: Implement the adapter**

```typescript
import { SafeJSON } from "@app/utils/json";
import type { Router } from "@app/dev-dashboard/server/router";
import type { RouteContext, RouteResult, RouteServices, SseEmitter } from "@app/dev-dashboard/server/types";

function toResponse(result: RouteResult): Response {
    if (result.kind === "json") {
        return new Response(SafeJSON.stringify(result.body), {
            status: result.status,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (result.kind === "text" || result.kind === "raw") {
        return new Response(result.body, {
            status: result.status,
            headers: { "Content-Type": result.contentType ?? "text/plain; charset=utf-8", ...(result.kind === "raw" ? result.headers : {}) },
        });
    }

    if (result.kind === "binary") {
        return new Response(result.body, {
            status: result.status,
            headers: { "Content-Type": result.contentType, "Content-Length": String(result.body.length), ...(result.headers ?? {}) },
        });
    }

    // sse — bridge emit -> ReadableStream
    const encoder = new TextEncoder();
    let handle: { close: () => void } | null = null;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const emit: SseEmitter = {
                data: (payload) => controller.enqueue(encoder.encode(`data: ${payload}\n\n`)),
                comment: (text) => controller.enqueue(encoder.encode(`:${text}\n\n`)),
            };
            handle = result.start(emit);
        },
        cancel() {
            handle?.close();
        },
    });

    return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
}

export async function routerToResponse(
    router: Router,
    req: Request,
    opts: { services: RouteServices }
): Promise<Response | null> {
    const url = new URL(req.url);
    const matched = router.match(req.method, url.pathname);

    if (!matched) {
        return null;
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
    });

    let cachedBody: string | undefined;
    const ctx: RouteContext = {
        method: req.method as RouteContext["method"],
        pathname: url.pathname,
        query: url.searchParams,
        params: matched.params,
        headers,
        readJson: async <T>() => {
            cachedBody ??= (await req.text()) || "{}";
            return SafeJSON.parse(cachedBody, { strict: true }) as T;
        },
        services: opts.services,
    };

    return toResponse(await matched.def.handler(ctx));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/server/adapters/bun-serve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/adapters/bun-serve.ts src/dev-dashboard/server/adapters/bun-serve.test.ts
git commit -m "feat(dd-agent): bun.serve adapter (json/text/binary/sse via ReadableStream)"
```

---

### Task 9: Registry assembly + background-services lifecycle

**Files:**
- Create: `src/dev-dashboard/server/registry.ts`
- Test: `src/dev-dashboard/server/registry.test.ts`

- [ ] **Step 1: Write the failing test (all known routes are registered)**

```typescript
import { describe, expect, it } from "bun:test";
import { createDashboardRouter } from "@app/dev-dashboard/server/registry";

const EXPECTED = [
    "GET /api/system/pulse", "GET /api/system/pulse/history",
    "GET /api/tmux/sessions", "POST /api/tmux/create", "POST /api/tmux/rename",
    "GET /api/ttyd/list", "POST /api/ttyd/spawn", "POST /api/ttyd/kill", "POST /api/ttyd/rename",
    "GET /api/cmux/snapshot", "GET /api/cmux/layout", "POST /api/cmux/create-terminal",
    "POST /api/cmux/create-workspace", "POST /api/cmux/send-session", "POST /api/cmux/remove-session",
    "POST /api/cmux/attach", "POST /api/cmux/rename",
    "GET /api/weather", "GET /api/claude/usage", "GET /api/claude/usage/history",
    "GET /api/daemon/status", "GET /api/daemon/runs", "GET /api/daemon/runs/log", "GET /api/containers",
    "GET /api/qa/log", "POST /api/qa/read", "GET /api/qa/audio-library", "GET /api/qa/sound",
    "POST /api/qa/config", "GET /api/qa/stream", "POST /api/qa/save-to-obsidian",
    "GET /api/todos", "POST /api/todos/request-access", "POST /api/todos", "POST /api/todos/complete",
    "PATCH /api/todos", "DELETE /api/todos",
    "GET /api/obsidian/tree", "POST /api/obsidian/mkdir", "GET /api/obsidian/note",
    "POST /api/obsidian/publish", "POST /api/obsidian/unpublish",
    "GET /share/:slug",
];

describe("createDashboardRouter", () => {
    it("registers every known route", () => {
        const router = createDashboardRouter();
        for (const route of EXPECTED) {
            const [method, pattern] = route.split(" ");
            // match against a concrete path for :slug
            const probe = pattern.replace(":slug", "tok");
            expect(router.match(method, probe), `missing ${route}`).not.toBeNull();
        }
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/dev-dashboard/server/registry.test.ts`
Expected: FAIL — `createDashboardRouter` not defined.

- [ ] **Step 3: Implement the registry + lifecycle**

```typescript
import { getConfig } from "@app/dev-dashboard/config";
import { startPolling } from "@app/dev-dashboard/lib/cmux/poller";
import { configureRetention, startPulsePolling } from "@app/dev-dashboard/lib/system/poller";
import { logger } from "@app/logger";
import { Router } from "@app/dev-dashboard/server/router";
import { claudeRoutes } from "@app/dev-dashboard/server/routes/claude";
import { cmuxRoutes } from "@app/dev-dashboard/server/routes/cmux";
import { containersRoutes } from "@app/dev-dashboard/server/routes/containers";
import { daemonRoutes } from "@app/dev-dashboard/server/routes/daemon";
import { obsidianRoutes } from "@app/dev-dashboard/server/routes/obsidian";
import { qaRoutes } from "@app/dev-dashboard/server/routes/qa";
import { shareRoutes } from "@app/dev-dashboard/server/routes/share";
import { systemRoutes } from "@app/dev-dashboard/server/routes/system";
import { tmuxRoutes } from "@app/dev-dashboard/server/routes/tmux";
import { todosRoutes } from "@app/dev-dashboard/server/routes/todos";
import { ttydRoutes } from "@app/dev-dashboard/server/routes/ttyd";
import { weatherRoutes } from "@app/dev-dashboard/server/routes/weather";

export function createDashboardRouter(): Router {
    return new Router().addAll([
        ...systemRoutes(), ...tmuxRoutes(), ...ttydRoutes(), ...cmuxRoutes(),
        ...weatherRoutes(), ...claudeRoutes(), ...daemonRoutes(), ...containersRoutes(),
        ...qaRoutes(), ...todosRoutes(), ...obsidianRoutes(), ...shareRoutes(),
    ]);
}

let started = false;

/** Boots the background pollers exactly once. Replaces the module-load side effects. */
export async function startBackgroundServices(): Promise<void> {
    if (started) {
        return;
    }

    started = true;

    try {
        const { cmuxPollIntervalMs, pulse } = await getConfig();
        startPolling(cmuxPollIntervalMs);
        configureRetention(pulse.retentionHours);
        startPulsePolling(pulse.pollIntervalMs);
    } catch (err) {
        logger.warn({ err }, "dev-dashboard: poller config load failed; using defaults");
        startPolling(2000);
        startPulsePolling(5000);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/dev-dashboard/server/registry.test.ts`
Expected: PASS (all 44 route probes match).

- [ ] **Step 5: Commit**

```bash
git add src/dev-dashboard/server/registry.ts src/dev-dashboard/server/registry.test.ts
git commit -m "feat(dd-agent): assemble router from all registrars + explicit poller lifecycle"
```

---

### Task 10: Re-point the Vite middleware at the registry (keep web working — M0 gate)

> The middleware keeps `requireDashboardAuth` (loopback/cookie semantics + the 401/503 responses)
> exactly as today, but the route `if`-chain becomes a single `handleWithRouter` delegation. This
> removes ~700 lines and guarantees web + agent share one code path.

**Files:**
- Modify: `src/dev-dashboard/ui/vite-middleware.ts`

- [ ] **Step 1: Replace the route chain with the adapter delegation**

```typescript
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { createDashboardRouter, startBackgroundServices } from "@app/dev-dashboard/server/registry";
import { handleWithRouter } from "@app/dev-dashboard/server/adapters/node-connect";

const router = createDashboardRouter();
const services = { collector: defaultSystemCollector() };
void startBackgroundServices();

export function attachDevDashboardMiddleware(middlewares: Connect.Server): void {
    middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://dev-dashboard.local");

        if (!(await requireDashboardAuth(req, res, url))) {
            return;
        }

        const handled = await handleWithRouter(router, req, res, { services });

        if (!handled) {
            next();
        }
    });
}
```

> Delete the inlined route handlers and the two module-load `getConfig().then(startPolling/…)`
> blocks (now in `startBackgroundServices`). Keep `requireDashboardAuth`, `readJson`,
> `sendJson` only if still referenced; otherwise remove. Keep all imports that `routes/*` now own.

- [ ] **Step 2: Run the existing dev-dashboard test suite**

Run: `bun test src/dev-dashboard/`
Expected: PASS (no regressions; front-proxy/auth/qa-sse tests still green).

- [ ] **Step 3: Manual smoke — web UI still serves**

Run: `tools dev-dashboard ui up --dev --foreground` then in another shell
`curl -s -u martin:<pw> localhost:3042/api/system/pulse | tools json`
Expected: a `PulseSnapshot` JSON (or `{capturedAt:null}` before first poll). Web UI loads in browser.

- [ ] **Step 4: Commit**

```bash
git add src/dev-dashboard/ui/vite-middleware.ts
git commit -m "refactor(dd): drive the Vite middleware from the extracted route registry"
```

---

### Task 11: Standalone Agent runtime + CLI subcommand

**Files:**
- Create: `src/dev-dashboard/server/serve.ts`
- Modify: `src/dev-dashboard/index.ts` (add `agent` subcommand)

- [ ] **Step 1: Implement `serveAgent`**

```typescript
import { getDashboardAuthCached } from "@app/dev-dashboard/config";
import { logger, out } from "@app/logger";
import { decideApiAuth } from "@app/dev-dashboard/server/auth-guard";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { createDashboardRouter, startBackgroundServices } from "@app/dev-dashboard/server/registry";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";

export async function serveAgent(opts: { port: number; host?: string }): Promise<void> {
    const router = createDashboardRouter();
    const services = { collector: defaultSystemCollector() };
    await startBackgroundServices();

    const server = Bun.serve({
        port: opts.port,
        hostname: opts.host ?? "0.0.0.0",
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

            const auth = decideApiAuth({
                method: req.method,
                pathname: url.pathname,
                headers,
                provision: await getDashboardAuthCached(),
                secure: headers["x-forwarded-proto"] === "https",
            });

            if (auth.decision === "deny") {
                return new Response("Authentication required.", {
                    status: 401,
                    headers: { "WWW-Authenticate": 'Basic realm="DevDashboard", charset="UTF-8"' },
                });
            }

            if (auth.decision === "unconfigured") {
                return new Response("Auth enabled but no password hash configured.", { status: 503 });
            }

            const res = await routerToResponse(router, req, { services });

            if (!res) {
                return new Response("Not found", { status: 404 });
            }

            if (auth.setCookie) {
                res.headers.append("Set-Cookie", auth.setCookie);
            }

            return res;
        },
    });

    logger.info({ port: server.port }, "DevDashboard Agent listening");
    out.println(`DevDashboard Agent on http://${opts.host ?? "0.0.0.0"}:${server.port}`);
}
```

> Note: ttyd terminals still require `startFrontProxy` for the WebSocket bridge. For the agent,
> either (a) keep the front-proxy in front (Agent serves `/api`, front-proxy bridges `/ttyd/*` +
> WS), or (b) fold the ttyd bridge into the Agent's `Bun.serve` (it already uses native upgrade).
> The transport plan (02) decides the final topology; for M0, `serveAgent` serves `/api` only and
> the existing `startFrontProxy` continues to own ttyd. This is called out in the ADR.

- [ ] **Step 2: Add the CLI subcommand in `index.ts`**

```typescript
import { serveAgent } from "@app/dev-dashboard/server/serve";

program
    .command("agent")
    .description("Run the standalone DevDashboard Agent (API only, no Vite)")
    .option("--port <port>", "port", (v) => Number.parseInt(v, 10), 3043)
    .option("--host <host>", "bind host", "0.0.0.0")
    .action(async (opts: { port: number; host: string }) => {
        await serveAgent({ port: opts.port, host: opts.host });
    });
```

- [ ] **Step 3: Smoke test the standalone Agent**

Run: `tools dev-dashboard agent --port 3043 &` then
`curl -s -u martin:<pw> localhost:3043/api/system/pulse | tools json`
Expected: a `PulseSnapshot` JSON. `curl -s localhost:3043/api/system/pulse -o /dev/null -w '%{http_code}'`
without creds → `401`.

- [ ] **Step 4: Commit**

```bash
git add src/dev-dashboard/server/serve.ts src/dev-dashboard/index.ts
git commit -m "feat(dd-agent): standalone Agent runtime + 'dev-dashboard agent' subcommand"
```

---

### Task 12: Logging-guard + final verification

- [ ] **Step 1: Ensure routes use `out.result`/`logger` correctly**

The route registrars must NOT call `logger.*(SafeJSON.stringify(...))` as a result channel. All
JSON bodies flow through the adapters' serialization, not the logger. Run the repo CI guard:

Run: `bash scripts/ci/logging-guard.sh`
Expected: PASS.

- [ ] **Step 2: Full typecheck + test**

Run: `bunx tsgo --noEmit | rg "dev-dashboard/server" ; bun test src/dev-dashboard/`
Expected: no type errors in `server/`; all tests pass.

- [ ] **Step 3: Update the dev-dashboard README**

Add an "Architecture" note documenting the registry + the `agent` subcommand, and that
`vite-middleware.ts` now delegates to `createDashboardRouter()`.

- [ ] **Step 4: Commit**

```bash
git add src/dev-dashboard/README.md
git commit -m "docs(dd): document the extracted Agent registry + agent subcommand"
```

---

## Self-Review checklist (run after implementing)

1. **Coverage:** every one of the 38 `/api` routes + `/share/:slug` appears in `registry.test.ts`'s
   `EXPECTED` and resolves. The qa SSE + qa/sound binary + share HTML are non-JSON results.
2. **Behavior parity:** status codes preserved (409 ttyd conflict, 503 reminders/unconfigured,
   400 missing params, 404 unknown note/slug/sound). `db.close()` in `finally` kept on all qa
   read-model routes.
3. **Type consistency:** `RouteResult` kinds (`json|text|binary|sse|raw`) handled identically in
   both adapters. `RouteContext.readJson` strict-parses via `SafeJSON`.
4. **No new behavior:** auth semantics unchanged (same `lib/auth.ts`); loopback exemption + cookie
   minting intact in BOTH the Vite path (`requireDashboardAuth`) and the Agent path (`decideApiAuth`).
5. **No placeholders:** the route→lib map enumerates every handler's exact call.

## Hand-off

This plan unblocks **03-SharedContract** (the contract package types are derived from these route
signatures) and **02-TransportTrust** (which decides whether ttyd lives behind the Agent or the
front-proxy). Implement 01 → 03 → 02 → 04.

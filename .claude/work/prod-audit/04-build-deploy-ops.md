# Build / Deploy / Ops Audit — Dashboard

_Audited: 2026-05-17 — READ-ONLY pass, no source files modified_

---

## P0 Blockers

### P0-1 — `/api/health` promised in DEPLOY.md, does NOT exist in apps/web

**File:** `src/dashboard/apps/web/src/routes/` (no `api.health.ts` present)

**Problem:**
`DEPLOY.md` documents `GET /api/health` as returning `200 {status:"ok"}` or `503`, and the PM2 ecosystem comment implies it for uptime monitoring. The route does NOT exist in the web app source tree or built `.output/server/`. The health endpoint that does exist (`apps/server/server/routes/api/health.ts`) lives in `apps/server`, which is explicitly NOT deployed.

**Impact:** PM2 / uptime monitors probing `/api/health` receive 404. No way to distinguish "process running" from "DB connected and migrated" for external monitoring.

**Fix — create `apps/web/src/routes/api.health.ts`:**

```ts
import { createFileRoute } from "@tanstack/react-router";
import { sqlite } from "@/drizzle";

export const Route = createFileRoute("/api/health")({
    server: {
        handlers: {
            GET: () => {
                try {
                    sqlite.prepare("SELECT 1").get();
                    return Response.json({ status: "ok", db: "ok" });
                } catch (err) {
                    return Response.json(
                        { status: "error", db: String(err) },
                        { status: 503 }
                    );
                }
            },
        },
    },
});
```

---

### P0-2 — `apps/web` has NO `check-types` script; turbo silently skips the type gate

**Files:**
- `src/dashboard/turbo.json` — `"build": { "dependsOn": ["^build", "check-types"] }`
- `src/dashboard/apps/web/package.json` — scripts: `dev`, `build`, `preview`, `test`, `lint`, `check`, `format`, `db:*` (NO `check-types`)

**Problem:**
When a workspace package lacks a `check-types` script, Turbo skips that step silently. TypeScript errors in `apps/web` will NOT block a production build. The `tsconfig.json` is strict mode, but the gate is not enforced.

`apps/docs` defines `check-types`. `packages/shared` and `packages/ui` define it. `apps/server` and `apps/web` do NOT.

**Fix — add to `apps/web/package.json` scripts:**
```json
"check-types": "tsc --noEmit"
```

And to `apps/server/package.json`:
```json
"check-types": "tsc --noEmit"
```

---

### P0-3 — `apps/web/.gitignore` missing `.env.*` pattern; dev `.env` has live credentials on disk

**Files:**
- `src/dashboard/apps/web/.gitignore` — ignores `.env` and `*.local` but NOT `.env.*`
- `src/dashboard/apps/server/.gitignore` — correctly has `.env.*` and `!.env.example`
- `src/dashboard/apps/web/.env` — exists on disk (gitignored currently), contains real credentials

**Problem:**
The dev `.env` contains a Neon Postgres URL with username/password (`npg_b5VtRZhP1dgo`), a WorkOS API key, and a WorkOS client ID. These are currently gitignored (confirmed via `git ls-files --others --ignored`), but the missing `.env.*` pattern means files like `.env.staging` or `.env.production` would NOT be ignored and could be accidentally committed.

The `.env` also contains stale Neon Postgres DATABASE_URL lines — the app is SQLite-only now, so these are dead config that could mislead future operators.

**Immediate action required:** Rotate the WorkOS API key and Neon credentials visible in the dev `.env`.

**Fix — add to `apps/web/.gitignore`:**
```
.env.*
!.env.example
```

---

## P1 — High Priority

### P1-1 — Root `build` script runs unfiltered turbo (builds docs + server unnecessarily for prod)

**File:** `src/dashboard/package.json` — `"build": "turbo run build"` (no filter)

**Problem:** Unfiltered `turbo run build` builds all three apps including `apps/docs` (Next.js) and `apps/server` (standalone Nitro on :4000). The ecosystem file deploys only `apps/web`. Building the others wastes CI time and can mask failures in unrelated code.

DEPLOY.md correctly says to use `--filter=@dashboard/web` for production builds, but an operator who runs `bun run build` from the dashboard root gets all three.

**Fix:** Add a dedicated prod-build script:
```json
"build:prod": "turbo run build --filter=@dashboard/web"
```

Or update the CI deploy step to always pass `--filter=@dashboard/web`.

---

### P1-2 — `MCP_BEARER_TOKEN` and `MCP_USER_ID` missing from `.env.example` and ecosystem file

**File:** `src/dashboard/apps/web/.env.example` — does not mention either MCP var.
**File:** `src/dashboard/ecosystem.config.cjs` `env_production` — does not include them.

**Problem:** An operator wanting MCP integration has no hint these env vars exist. Both are `optional()` in the Zod schema, so boot does not fail — the `/mcp` route silently returns 501.

**Fix — append to `.env.example`:**
```bash
# MCP endpoint auth — optional. Both required to enable /mcp; if absent, /mcp returns 501.
# MCP_BEARER_TOKEN=<at-least-16-random-chars>
# MCP_USER_ID=<workos_user_id_of_the_dashboard_owner>
```

**Fix — add to `ecosystem.config.cjs` `env_production`:**
```js
MCP_BEARER_TOKEN: "",   // fill to enable /mcp endpoint
MCP_USER_ID: "",        // WorkOS user ID of the dashboard owner
```

---

### P1-3 — `PORT` env var undocumented in `.env.example`

**Source:** Built `apps/web/.output/server/index.mjs` line 4161:
`process.env.NITRO_PORT ?? process.env.PORT ?? ""`

The ecosystem file sets `PORT: "3000"` in `env_production`, but `.env.example` and the Zod schema do not mention it. Operators running without the PM2 ecosystem env block (e.g. bare `node .output/server/index.mjs`) get Nitro's default.

**Fix — add to `.env.example`:**
```bash
# Nitro listens on NITRO_PORT ?? PORT. PM2 ecosystem sets PORT=3000; override here if needed.
PORT=3000
```

---

### P1-4 — No structured request logging; all prod logs are plain `console.log` to PM2 stdout

**Problem:** The application has no structured (JSON/pino) access logging and no error tracking. Prod logs go to `/var/log/dashboard/web-{out,error}.log` as plain text. Diagnosing prod issues requires manual grep. There is no request-level tracing.

**Recommended fix:** Configure Nitro's built-in log level in `vite.config.ts`:
```ts
const nitroConfig: NitroConfig = {
    logLevel: process.env.NODE_ENV === "production" ? 3 : 0,
    // ...
};
```

For structured logging, wrap `console.log` calls in `drizzle/index.ts` with pino (already a dependency in the parent monorepo). For a personal deployment this is low-urgency but becomes important when diagnosing issues remotely.

---

## P2 — Medium Priority (ops hygiene)

### P2-1 — Node version pinned correctly; `better-sqlite3` ABI warning documented

**Files:**
- `src/dashboard/.node-version`: `22` — correct
- `src/dashboard/package.json`: `"engines": { "node": ">=22" }` — correct

DEPLOY.md warns about `better-sqlite3` native module ABI mismatch. No action needed; documented correctly. Ensure CI build host matches the runtime host (both Node 22).

### P2-2 — `apps/docs` (Next.js) in turbo graph but not deployed

`apps/docs` builds Next.js and is not in the PM2 ecosystem. It is harmless if it builds successfully. Consider excluding it with `--filter` in CI or adding it to a separate deploy pipeline.

### P2-3 — Graceful shutdown: correct, but no in-flight request drain

**File:** `src/dashboard/apps/web/src/drizzle/index.ts` lines 46–68

SIGTERM/SIGINT handlers correctly close the SQLite handle. However, `process.exit(0)` is called immediately after closing — in-flight SSE connections and ongoing HTTP requests are abruptly dropped rather than allowed to drain.

**Recommended improvement:**
```ts
process.once("SIGTERM", () => {
    // Allow 5s for in-flight requests to complete before closing DB
    setTimeout(() => closeOnce(), 5000);
});
```

Also add `kill_timeout: 8000` to the PM2 ecosystem (PM2 default is 1600ms, which may not give the 5s drain time to complete):
```js
kill_timeout: 8000,
```

### P2-4 — Static assets: correctly served by Nitro, no separate static host needed

The built `.output/` contains `.output/server/index.mjs` + `.output/public/` (hashed assets). Nitro self-serves both. The nginx config in DEPLOY.md that proxies `/assets/` through to port 3000 is correct. No action needed.

### P2-5 — `apps/server` WebSocket uses in-memory `clients` Map (not deployed, no current risk)

**File:** `src/dashboard/apps/server/server/routes/_ws.ts`

In-memory `Map<string, Client>` — would break under cluster mode. Correctly excluded from deployment (`vite.config.ts` sets `experimental.websocket: false`; ecosystem file omits `apps/server`). Consider archiving or deleting `apps/server` if it is permanently abandoned.

---

## Summary Table

| ID | Severity | Location | Issue | Fix |
|----|----------|----------|-------|-----|
| P0-1 | P0 | `apps/web/src/routes/api.health.ts` (missing) | `/api/health` documented but doesn't exist | Create route with `SELECT 1` DB probe |
| P0-2 | P0 | `apps/web/package.json` scripts | Missing `check-types`; type errors don't block build | Add `"check-types": "tsc --noEmit"` |
| P0-3 | P0 | `apps/web/.gitignore` + `.env` | `.env.*` not ignored; dev `.env` has live credentials | Add pattern; ROTATE KEYS NOW |
| P1-1 | P1 | Root `package.json` `build` script | Unfiltered turbo builds docs+server | Add `build:prod` with `--filter=@dashboard/web` |
| P1-2 | P1 | `.env.example`, `ecosystem.config.cjs` | MCP vars undocumented | Add commented entries |
| P1-3 | P1 | `.env.example` | `PORT` missing | Add `PORT=3000` |
| P1-4 | P1 | App-wide | No structured request logging | Configure Nitro logLevel / pino |
| P2-1 | P2 | — | Node 22 pinned correctly | Document ABI warning in runbook |
| P2-2 | P2 | `apps/docs` | In turbo graph, never deployed | Exclude with `--filter` in CI |
| P2-3 | P2 | `drizzle/index.ts` | No request drain on SIGTERM; PM2 `kill_timeout` too short | Add 5s grace + `kill_timeout: 8000` |
| P2-4 | P2 | — | Static assets served by Nitro correctly | No action |
| P2-5 | P2 | `apps/server/_ws.ts` | In-memory WS clients Map, not deployed | Archive/delete if abandoned |

---

## PM2 Ecosystem File: Current State vs Recommended

**`src/dashboard/ecosystem.config.cjs` is largely correct.** Fork mode + 1 instance + absolute paths + separate log files are all right.

**Recommended additions to `env_production`:**
```js
kill_timeout: 8000,     // allow SIGTERM handler + 5s drain before SIGKILL
MCP_BEARER_TOKEN: "",   // fill to enable /mcp; leave empty to disable
MCP_USER_ID: "",        // WorkOS user ID of dashboard owner
// PORT is already set to "3000" — correct
```

---

## Can it build and run today?

**Build:** YES — `turbo run build --filter=@dashboard/web` produces a valid `apps/web/.output/server/index.mjs` (output confirmed present). This is a full SSR Nitro/Node build — a running Node 22 process is required (not static hosting).

**Run:** YES, with prerequisites:
- All four `WORKOS_*` vars must be populated (fail-fast at boot if missing — correct behavior)
- `SQLITE_PATH` must be an absolute path in production (enforced in code — correct)
- Migrations run automatically at boot from `MIGRATIONS_DIR`
- `pm2 start ecosystem.config.cjs --env production` is the correct start command

**PM2 mode verdict: FORK MODE / SINGLE INSTANCE — mandatory and already correctly configured.** The in-memory SSE event bus (`lib/events/event-bus.server.ts`) and the better-sqlite3 single-writer contract are fundamentally incompatible with PM2 cluster mode. Do NOT change this.

**Env adequacy: PARTIAL.** WorkOS vars and SQLite path are documented. Missing: `PORT`, MCP vars. Dev `.env` has live credentials that need rotation.

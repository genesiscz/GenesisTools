# Impl notes — Plan 01 (Server Extraction), Tasks 1–9

> Status as of 2026-05-29. The additive `src/dev-dashboard/server/` extraction module is **complete,
> tested, typechecked, and committed**. The live `vite-middleware.ts` is **untouched** — the cutover
> (Task 10) + standalone serve (Task 11) are **reserved for human review** (see checklist below).

## Done (committed)

Tasks 1–9, in commits `027468e7a` → `b29a34011` (+ `4df103e66` formatting):
- **types.ts** — `RouteContext` / `RouteResult` (json|text|binary|sse|raw) / `RouteDef` / `SseEmitter`.
- **router.ts** — method + `:param` matching (`Router.add/addAll/match`).
- **auth-guard.ts** — `decideApiAuth` (pure mirror of `requireDashboardAuth`; reuses `lib/auth.ts`).
- **collector/SystemCollector.ts** — interface + `MacSystemCollector` (wraps `collectPulse`).
- **routes/*.ts** — all 12 feature registrars (`systemRoutes`, `tmuxRoutes`, `ttydRoutes`,
  `cmuxRoutes`, `weatherRoutes`, `claudeRoutes`, `daemonRoutes`, `containersRoutes`, `qaRoutes`,
  `todosRoutes`, `obsidianRoutes`, `shareRoutes`) + `error.ts` helper. 42 routes total.
- **routes/qa.ts** — the `/api/qa/stream` SSE result + `/api/qa/sound` binary result.
- **adapters/node-connect.ts** — `handleWithRouter` (Vite/Connect; json/text/binary/sse).
- **adapters/bun-serve.ts** — `routerToResponse` (standalone `Bun.serve`; ReadableStream for SSE).
- **registry.ts** — `createDashboardRouter()` + `startBackgroundServices()` (poller lifecycle).

**Verification:** `bun test src/dev-dashboard/server/` → **15 pass / 0 fail**. `tsgo --noEmit` →
**no errors** in `dev-dashboard/server`. Pre-commit hook (biome + tsgo) passed on every commit.

## Fixes applied beyond the plan (the agent died mid-Task-5 to a 529; these were finished by hand)

- `routes/obsidian.ts` (tree + note) & `routes/share.ts`: added `if (!obsidianVault)` guards — the
  config's `obsidianVault` is `string | undefined`; `listVault`/`readNote` require `string`. Mirrors
  the guard already used by `mkdir`/`save-to-obsidian`. Behavior: 500 "obsidian vault not configured".
- `routes/qa.ts` (save-to-obsidian): `formatQaAsMarkdown({ ...row, ...enriched, … })` — spread `row`
  (the full `QaRow`) first so all `QaRow` fields are present (the bare `...enriched` spread didn't
  satisfy the `QaRow` param under the current types).
- `adapters/bun-serve.ts` (binary): `new Response(new Uint8Array(result.body), …)` — copy into an
  `ArrayBuffer`-backed view (a Buffer / `Uint8Array<ArrayBufferLike>` isn't assignable to `BodyInit`
  under TS 5.7 typed-array generics).

## Task 10 — cutover APPLIED + verified (2026-05-29)

`src/dev-dashboard/ui/vite-middleware.ts` now keeps `requireDashboardAuth` **verbatim**, then delegates
every request to `handleWithRouter(createDashboardRouter(), …)`. The inlined ~740-line route chain is
gone; the two module-load poller blocks are replaced by a single `void startBackgroundServices()`.
(921 → ~115 lines.)

**Verified — done safely (never touched the live `:3042`, never ran `ui up`):**
- `tsgo --noEmit` → no `dev-dashboard` type errors (imports + delegation typecheck clean).
- `bun test src/dev-dashboard/server/` → **15/15 pass**.
- Ephemeral free-port real-HTTP smoke (registry → node-connect adapter → real `lib`): `/api/system/pulse`
  → `200 {"capturedAt":null}`, `/api/cmux/snapshot` → `200` real `CmuxSnapshot`, `/nope` → `404`.

**Still to glance on the LIVE setup (can't be done safely from the worktree):** the `/api/qa/stream`
SSE end-to-end through the front-proxy, and a ttyd terminal's cookie-auth WS — both bypass this
middleware via the front-proxy so are unaffected by the cutover, but worth a live check. NOTE: the
live dashboard runs from the **main repo** process; it only picks up this change when restarted from
a tree containing this commit.

## NOT done — Task 11 (standalone Agent)

- **Task 11 — standalone Agent.** `server/serve.ts` (`serveAgent`) + the `dev-dashboard agent` CLI
  subcommand (`Bun.serve` mounting the router + `decideApiAuth` + `startBackgroundServices`).

## Reviewer checklist before the Task-10 cutover

1. `bun test src/dev-dashboard/` (full suite, not just `server/`) — confirm no regressions.
2. `tools dev-dashboard ui up --dev --foreground`; load the web UI — Pulse, terminals, QA, Obsidian
   all render.
3. `curl -s -u <user>:<pw> localhost:3042/api/system/pulse | tools json` (+ a few other routes) —
   confirm parity with the new registry once cut over.
4. Confirm the `/api/qa/stream` SSE + a ttyd terminal still work (those bypass the middleware via the
   front-proxy — unaffected by the cutover, but verify).
5. Only then commit the cutover.

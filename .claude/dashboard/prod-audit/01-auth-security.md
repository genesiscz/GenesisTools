# Prod Audit 01 — Auth, Security & Multi-User Data Isolation

Scope: `src/dashboard/` monorepo. Production target: small trusted group, real auth + per-user
isolation required, self-hosted Node/PM2, `apps/web` only (`apps/server` not deployed).

Date: 2026-05-17. Read-only audit.

> **Supersedes a pre-remediation draft of this file.** An earlier version of this report
> described the codebase *before* commits **`63565f9c` (server-side auth — AuthKit session,
> route guards, kill localStorage)** and **`632aad47` (enforce per-user data isolation —
> server-derived identity)**. Those two commits closed the 9 P0s the prior draft flagged
> (client-supplied `userId` IDOR, no route guards, querystring-auth SSE/ai-chat, avatar IDOR,
> unauth MCP, localStorage session, etc.). This report reflects the **current** code on
> branch `feat/dev-dashboard`. If a sibling audit report references "client-supplied userId"
> or "auth not enforced server-side" as present problems, it is reading the pre-remediation
> state — discount it.

---

## Summary verdict

- **DB is per-user isolated**, not single-tenant. Every table carries an indexed `user_id`
  column, and every data server function derives the user id server-side from the session
  cookie (`requireUserId()` → AuthKit `getAuth()`), never from client input, then filters
  every query by it. Verified exhaustively (all 18 assistant query sites, all timer-sync
  queries, all `db.delete` calls, every `inputValidator` signature). This is the
  make-or-break finding and it **passes — with one exception** (P0-1 below).
- **Auth works end-to-end.** WorkOS AuthKit is genuinely wired (password, OAuth, email
  verification, password reset). Session is an httpOnly, iron-sealed cookie owned by AuthKit.
  Route guards (`requireAuthBeforeLoad`) AND server-fn guards (`requireUserId`) both present.
  Env is zod-validated fail-fast at boot (`lib/env.ts`, all `WORKOS_*` required).
- **1 P0** (cross-user message deletion), **2 P2**, **2 P3**.

---

## P0 Blockers

### P0-1 — Cross-user data destruction in `deleteConversation` (unscoped cascade delete)

- **File:** `apps/web/src/lib/ai/ai.server.ts:65`
- **Severity:** P0 — authenticated user can destroy another user's data.
- **Why it survived the isolation remediation:** commit `632aad47` swept input validators and
  added `requireUserId()`; it did not audit cascade-delete *ordering*. This is the one
  remaining cross-user mutation path.
- **Problem:** `deleteConversation` deletes child messages by `conversationId` only, with **no
  ownership precheck and no `userId` filter**, *before* the ownership-scoped conversation
  delete:

  ```ts
  db.delete(aiMessages).where(eq(aiMessages.conversationId, data.id)).run();          // UNSCOPED
  db.delete(aiConversations)
      .where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, userId)))  // scoped, too late
      .run();
  ```

  `aiMessages` has no `userId` column (only `conversationId`). Authenticated user A calls
  `deleteConversation({ id: <B's conversationId> })`. Line 65 wipes **all of B's messages** in
  that conversation. Line 67 then no-ops (ownership filter fails) — so B's conversation row
  survives but its messages are silently destroyed. Directly violates the trusted-group "one
  user must not mutate another's data" requirement.

- **Fix:** Mirror the pattern `listMessages` / `appendMessage` (same file) already use — SELECT
  the conversation, verify `conv.userId === userId`, throw 403 on mismatch, then delete both
  inside a transaction:

  ```ts
  const conv = db.select({ userId: aiConversations.userId })
      .from(aiConversations).where(eq(aiConversations.id, data.id)).get();
  if (!conv || conv.userId !== userId) throw new Response("Forbidden", { status: 403 });
  db.transaction((tx) => {
      tx.delete(aiMessages).where(eq(aiMessages.conversationId, data.id)).run();
      tx.delete(aiConversations).where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, userId))).run();
  });
  ```

---

## P2

### P2-1 — Bookmark metadata fetch: SSRF via redirect (initial-URL-only validation)

- **File:** `apps/web/src/lib/bookmarks/bookmarks.server.ts` — `assertSafeUrl` at :129,
  `fetch` at :159 (`fetchUrlMetadata`).
- **Severity:** P2 (auth-gated via `requireUserId()`, trusted group — not P0, but a real gap).
- **Problem:** `assertSafeUrl()` validates only the **initial** user-supplied URL (good:
  http/https allowlist, blocks `localhost`/`127.*`/`10.*`/`192.168.*`/`172.16-31.*`/
  `169.254.*`/`::1`, 8s timeout, 64KB cap). But `fetch()` uses the default
  `redirect: "follow"`. An attacker-controlled host can `302 → http://127.0.0.1:<port>/...`
  or `169.254.169.254` (cloud metadata); the redirect target is never re-validated.
- **Fix:** `redirect: "manual"` + re-run `assertSafeUrl()` on each `Location` (bounded hop
  count), or `redirect: "error"`. DNS-rebinding (resolve hostname, reject private IPs) is a
  lower-priority follow-up for a trusted group.

### P2-2 — `aiMessages` has no `userId` column (structural root of P0-1)

- **File:** `apps/web/src/drizzle/schema.ts` (`aiMessages` table).
- **Severity:** P2 (structural; the proximate exploit is P0-1).
- **Problem:** Every other table has `userId` + index; `aiMessages` is scoped only
  transitively via `aiConversations`. All correct paths (`listMessages`, `appendMessage`,
  `api.ai-chat`) do an explicit ownership precheck — the missing column is *why* P0-1 was
  possible and is a latent footgun for future query authors.
- **Fix:** Add `userId` (+ index) to `aiMessages`, backfill from parent conversation in a
  migration, scope message queries directly by `userId`. Also closes P0-1 structurally.

---

## P3 / Hygiene

### P3-1 — `apps/server` (Nitro :4000) contains unauthenticated endpoints (not deployed)

- **Files:** `apps/server/server/routes/_ws.ts` (WS broadcasts timer events to ALL clients,
  cross-user, no auth; `userId` field declared but never set), `.../api/timers/index.ts`
  (in-memory store, `user_id: "anonymous"`, no auth), `.../api/sync/upload.ts` (no auth,
  no-op TODO).
- **Severity:** P3 — **not deployed**. `ecosystem.config.cjs` header and `DEPLOY.md`
  explicitly state `apps/server` is not run in production; the PM2 config has no entry for it
  (correct); `apps/web` never dials it. Inert in the production target.
- **Note:** `apps/server/.../api/user.ts` is correctly fail-closed (401 without Bearer, else
  501 "WorkOS token verification not implemented", never returns a placeholder user). That
  one is fine by design.
- **Fix:** Add `// DO NOT DEPLOY — unauthenticated, see DEPLOY.md` headers to `_ws.ts`,
  `timers/index.ts`, `sync/upload.ts`. Keep the PM2 config free of an `apps/server` entry
  (already the case).

### P3-2 — Confirm AuthKit session cookie `Secure` flag in production

- **Where:** AuthKit cookie writer (delegated to `@workos/authkit-tanstack-react-start`,
  driven by `WORKOS_REDIRECT_URI`). The deployed `WORKOS_REDIRECT_URI` is
  `https://your.domain/auth/callback` (https), so AuthKit derives a `Secure`,
  `SameSite=Lax`, httpOnly cookie. Could not fully trace the library default from
  `node_modules` (transitively delegated). **Severity P3** — verify at deploy time that the
  prod `WORKOS_REDIRECT_URI` is `https://` (it is in the shipped config) so the session
  cookie is never sent over plaintext. TLS terminates at the nginx/Caddy reverse proxy.

### P3-3 — `__root.tsx` page `<title>` is "TanStack Start Starter"

- **File:** `apps/web/src/routes/__root.tsx`. Cosmetic; noting for prod-readiness.

---

## Detailed findings (per audit angle)

### 1. WorkOS integration completeness — PASS

- `apps/web/src/lib/auth-actions.ts`: `signInFn`, `signUpFn`, `verifyEmailFn`,
  `getOAuthUrlFn` — all real WorkOS `userManagement.*` calls, zod-validated, structured error
  mapping that deliberately avoids dumping tokens/PII into logs
  (`handleWorkOSError` → `console.warn` with code only).
- `apps/web/src/lib/password-reset-actions.ts`: `forgotPasswordFn` (always returns success —
  anti-enumeration, good), `resetPasswordFn` (WorkOS `resetPassword({token,...})`). Wired.
- `apps/web/src/routes/auth/callback.tsx`: `handleCallbackRoute` from
  `@workos/authkit-tanstack-react-start` with onSuccess/onError. Real OAuth callback.
- **WorkOS API key source:** `process.env.WORKOS_API_KEY` via `new WorkOS(...)` singleton in
  `apps/web/src/lib/auth-server.ts:6`. **Validated** by `apps/web/src/lib/env.ts` (zod:
  `WORKOS_API_KEY.min(1)`, `WORKOS_CLIENT_ID.min(1)`, `WORKOS_REDIRECT_URI.url()`,
  `WORKOS_COOKIE_PASSWORD.min(32)`, optional `MCP_BEARER_TOKEN.min(16)` + `MCP_USER_ID`).
  `createEnv` throws at boot if any required var missing — fail-fast.
- **Session cookie:** httpOnly, set server-side by AuthKit. `establishAuthSession`
  (`apps/web/src/lib/auth/session.ts`) iron-seals the session (`sealData`, iron-session,
  `WORKOS_COOKIE_PASSWORD` length-checked ≥32 in `auth-server.ts:encryptSession`) and hands
  it to AuthKit's `saveSession` — exactly one session system, nothing in localStorage
  (`signin.tsx` comment: "Session cookie is set server-side by AuthKit; nothing to persist
  client-side"). SameSite=Lax; Secure derived from https `WORKOS_REDIRECT_URI` (see P3-2).

### 2. Session validation — PASS (both layers present)

- **Route guard:** `requireAuthBeforeLoad()` (`apps/web/src/lib/auth/requireUser.ts`) wired
  via `beforeLoad` on `routes/dashboard/route.tsx`, `routes/assistant/route.tsx`,
  `routes/timer/index.tsx`, `routes/timer.$timerId.tsx` — redirects unauthenticated to
  `/auth/signin?returnTo=...`. SSR + client. `start.ts` registers `authkitMiddleware()`.
- **Server-fn guard (the real boundary):** `requireUserId()` reads `getAuth().user.id`,
  throws `401 Response` if no session. Called at the top of **every** data server fn.
  Coverage verified: handler count == `requireUserId` count per file (`assistant.server.ts`
  46/46, `timer-sync.server.ts` 17 sites, `notes` 6/6, `ai` 7, `bookmarks` 6, `planner` 1/1,
  `profile` 3/3). **No `inputValidator` accepts `userId`** — every signature is
  `Omit<New*, "userId">`, `{ id: string }`, `{ limit?: number }`, etc. The
  `DEV_USER_ID = "dev-user"` fallbacks (~12 files) are **client-only**
  (`import.meta.env.DEV`, build-time false in prod) feeding UI hooks; isolation is enforced
  server-side from the cookie. Regression test:
  `apps/web/src/lib/auth/__tests__/no-client-userid.test.ts`.

### 3. Per-user data isolation — PASS (except P0-1)

- Schema: all 20+ tables carry `user_id NOT NULL` + index. Not single-tenant.
- Every SELECT/UPDATE/DELETE in `timer-sync.server.ts`, `assistant.server.ts` (all 18 query
  sites inspected individually — every one has `eq(<table>.userId, userId)`),
  `notes.server.ts`, `ai.server.ts`, `bookmarks.server.ts`, `planner.server.ts`,
  `profile-server.ts` filters by the session-derived `userId` (id-targeted ops use
  `and(eq(id), eq(userId))`). `aiMessages` access is ownership-prechecked via the parent
  conversation everywhere **except** the P0-1 delete path.
- `db.delete` sweep: all delete calls `and(eq(id), eq(userId))`-scoped except
  `ai.server.ts:65` (P0-1). `assistantTasks` delete does not cascade to child tables
  (`assistantBlockers`/`assistantHandoffs`/`assistantContextParking`/`assistantDeadlineRisks`
  index by `taskId`, but there is no orphan-cleanup delete), so no sibling cascade
  vulnerability.

### 4. `apps/server/.../api/user.ts` 501 — fail-closed by design, NOT a break

- 401 without Bearer, else 501 "WorkOS token verification not implemented"; deliberately
  never returns a placeholder user. Nothing in `apps/web` depends on it (`apps/server` not
  deployed; web uses TanStack server fns + AuthKit). Safe.

### 5. `api.avatar.$userId.ts` — PASS

- `apps/web/src/routes/api.avatar.$userId.ts`: requires authenticated viewer
  (`getUserIdFromRequest`, 401 if absent), validates `userId` against `^[A-Za-z0-9_-]+$`
  (no path traversal), reads only from `process.cwd()/.data/avatars/<id>.<ext>` with fixed
  ext allowlist. No SSRF (local file read only). `profile-actions.ts` avatar write/remove
  derive `userId` from `requireUserId()` and apply `SAFE_USER_ID` regex before any FS or
  WorkOS write — the prior-draft IDOR is remediated. Minor: any authenticated user can fetch
  any other user's avatar (low sensitivity; acceptable for a trusted group).

### 6. SSE & WebSocket — PASS (web), see P3-1 (server)

- `api.events.ts` / `api.timer-events.ts`: both call `getUserIdFromRequest(request)` (reads
  session cookie via AuthKit `withAuth`), 401 if unauthenticated, subscribe scoped to that
  `userId`. **No `?userId=` querystring** (prior-draft issue remediated). `?domain=` is an
  added filter, not an authz bypass. Unauthenticated clients cannot subscribe; authenticated
  clients receive only their own events.
- The unauth cross-user-broadcasting WS is in `apps/server/_ws.ts` — not deployed (P3-1).

### 7. `mcp.ts` route — PASS (fail-closed)

- `apps/web/src/routes/mcp.ts`: disabled (501) unless **both** `MCP_BEARER_TOKEN` (≥16) and
  `MCP_USER_ID` set. When enabled: constant-time bearer comparison (`timingSafeEqual`), MCP
  server bound to the single configured owner user — `createMcpServer(ownerUserId)`, no
  `userId` tool argument, no cross-user access (`lib/mcp/server.ts`). Not publicly exposed by
  default. (Prior-draft "unauthenticated MCP" remediated.)

### 8. Secrets / env / CORS / CSRF — PASS

- Only `.env.example` files tracked; `git ls-files | rg -x 'apps/web/\.env'` returns nothing
  — `apps/web/.env` (present on disk) is **not tracked**. `.gitignore:27-29` ignores
  `.env`/`.env.*` (keeps `!.env.example`). `ecosystem.config.cjs` ships empty
  `WORKOS_*`/`ANTHROPIC_API_KEY` placeholders with "never commit real values". No hardcoded
  secrets.
- **CSRF:** `isSameOrigin()` (Origin/Referer vs `WORKOS_REDIRECT_URI` origin) enforced on
  raw `POST /api/ai-chat`; session cookie SameSite=Lax; TanStack server fns are same-origin
  RPC. Adequate for the model.
- **CORS:** No CORS headers (Nitro/h3 default — verified, no `Access-Control-Allow-*` /
  `credentials:true`). Same-origin behind nginx/Caddy reverse proxy (`DEPLOY.md`). Correct
  for this architecture.

---

## Recommended fix order for the trusted-group launch

1. **P0-1** — ownership precheck + transaction in `deleteConversation` (blocks launch).
2. **P2-1** — redirect re-validation in bookmark metadata fetch.
3. **P2-2** — add `userId` to `aiMessages` (also closes P0-1 structurally).
4. **P3-1** — "DO NOT DEPLOY" headers on `apps/server` unauth routes.
5. **P3-2** — confirm prod `WORKOS_REDIRECT_URI` is https (ships as https; Secure cookie).

# 22 — DevDashboard Cloud (Plan 10) — Implementation Notes

> Build of **DevDashboard Cloud** web product: marketing landing + auth + customer dashboard
> (managed setup/instructions/settings/billing). App lives at `DevDashboard/cloud/web/`.

## ⚠️ Worktree-base flag (orchestrator must confirm)

This agent's worktree was created off **`581f71f70`** (the **tmux/cmux dev-dashboard** line), NOT the
stated **`10981acc5`** (`feat/dev-dashboard-mobile` tip). The two diverged at `a75b6586e`. The
`581f71f70` base has **no `DevDashboard/` directory** and a different `src/dev-dashboard/` — so the
reference files Plan 10 depends on (the obsidian-terminal landing, DECISIONS.md, the cloudflared/e2e
seams) were absent.

**Resolution:** `git reset --hard 10981acc5` after verifying (a) the worktree tree was clean and
(b) the 19 wrong-base commits are preserved on `feat/tmux-cmux-dev-dashboard` + a new
`backup/agent-a1049-wrongbase` pointer. This mirrors the existing repo convention
(`backup/agent-a2b3ef-wrongbase`, `backup/agent-a326-wrongbase` already existed — other agents hit the
same wrong-base). **Orchestrator: confirm `10981acc5` is the intended integration target before
merging this branch.**

## Architecture

**Stack (mirrors `src/dashboard/apps/web`):** Vite + React 19 + **TanStack Start + Nitro**,
file-based routes in `src/routes/`, Tailwind v4, Biome. Chosen over a plain Vite SPA because
Better-Auth, Stripe webhooks, and Cloudflare-for-SaaS provisioning are ALL server-side — TanStack
Start gives server route handlers (`createFileRoute(...).server.handlers`) and server functions
(`createServerFn`) in the same app. This also overrides Plan 10's separate `cloud/api/` Hono service:
everything is folded into `cloud/web/` per the task.

**Visual:** the **Obsidian Terminal** design (`DevDashboard/cloud/landing/obsidian-terminal/index.html`)
ported to real React + Tailwind v4 (`src/styles/app.css` `@theme`): silk easing, mesh orbs, grain,
double-bezel cards, gradient text, Fontshare fonts (Clash Display / General Sans / Satoshi). The repo
`@ui` design-system tokens are deliberately NOT used — the cloud product is a separate design world
(like youtube/dev-dashboard diverge per `.claude/docs/design-system-dashboards.md`). The
`obsidian-design-system.md` doc the task referenced **does not exist** on any branch (verified via
fd / mdfind / git log --all) — the aesthetic was derived from the landing HTML + DECISIONS.md.

### Directory layout (`DevDashboard/cloud/`)
- `shared/` — framework-agnostic, importable by web + tests:
  - `tier-policy.ts` — **single source of truth** for the 4 trust tiers + exact claim strings (D11).
    All landing trust copy derives from here; a parity test asserts the claim semantics.
  - `account-model.ts` — DTOs + `CLOUD_PERSISTABLE_FIELDS` allow-list (what the cloud may store).
  - `data-boundary.ts` — `assertNoKeyMaterial(table, record)` guard; every domain write calls it.
- `web/` — the app:
  - `src/routes/` — `index` (landing), `signup`, `signin`, `api.auth.$` (Better-Auth handler),
    `api.stripe.webhook`, `dashboard` (protected layout) + `dashboard.{index,setup,devices,settings,billing}`.
  - `src/components/landing/*` — Hero, TrustStory, Features, HowItWorks, Pricing, Footer, Nav, icons.
  - `src/components/auth/AuthCard.tsx`, `src/components/dashboard/Card.tsx`.
  - `src/lib/auth/` — `auth.server.ts` (Better-Auth instance), `auth-service.ts` (thin interface),
    `auth-client.ts` (React client), `auth.functions.ts` (`getMe` server fn).
  - `src/lib/db/` — `index.ts` (the single DB access point = SQLite↔Postgres swap point),
    `schema.ts`, `migrate.ts` (migrate-on-boot), `cloud-store.ts` (domain writes, boundary-guarded).
  - `src/lib/dashboard/dashboard.functions.ts`, `src/lib/billing/`, `src/lib/provision/cloudflare.ts`,
    `src/lib/server/env.ts` (the only `process.env` reader).
  - `db/migrations/` — generated drizzle migration (8 tables).
- `src/dev-dashboard-cloud/index.ts` — **DashboardApp commander entry** (`tools dev-dashboard-cloud`,
  alias `dd-cloud`); registered in `src/utils/ui/dashboards.ts` @ **port 7251**.

## Auth — Better-Auth + SQLite, pluggable (the WORKOS/BETTER-AUTH FLAG)

**FLAG (per task):** the user's *stack* answer said "auth same as `src/dashboard` = WorkOS"; the user's
*auth* answer said "better-auth sqlite". These conflict. The orchestrator chose **Better-Auth + SQLite**
and asked to document **WorkOS as the alternate adapter** and keep the layer swappable. Done:
- Concrete adapter is isolated in `src/lib/auth/auth.server.ts` (`betterAuth(...)` + drizzleAdapter +
  `tanstackStartCookies()` plugin, email+password).
- All app code talks to the thin `auth-service.ts` interface (`getSessionUser` / `requireAuth` /
  `handler`) — never `auth.api.*` directly.
- **To swap to WorkOS:** replace `auth.server.ts` with the WorkOS AuthKit handler (the reference wires
  `@workos/authkit-tanstack-react-start` in `src/dashboard/apps/web/src/start.ts` +
  `routes/auth/callback.tsx`), re-point `auth-service.ts` at it, set `WORKOS_*` env. Nothing else changes.

## DB — SQLite now, Postgres-ready

- Single access point `src/lib/db/index.ts` reads `DD_CLOUD_DATABASE_DRIVER` (sqlite|postgres). SQLite
  uses `better-sqlite3` + `drizzle-orm/better-sqlite3`. Postgres branch is the documented prod path:
  `drizzle-orm/node-postgres` is already installed; going live needs `pg` + a `schema.pg.ts` mirror +
  swapping the dialect in this one file. It **fails loud** (throws) on `driver=postgres` rather than
  silently falling back, so a misconfigured prod deploy is obvious.
- **Tables:** Better-Auth core (`user`, `session`, `account`, `verification`) + domain
  (`subscriptions`, `devices` [paired PUBLIC keys], `managed_subdomains`, `account_settings`),
  all keyed by the Better-Auth `user.id`. Migration generated (`db/migrations/0000_*.sql`),
  applied on first DB access via `migrate.ts` (idempotent).
- **Data boundary (D11):** `CloudStore` routes every domain write through `assertNoKeyMaterial` — the
  cloud can never persist private key material or any field outside the per-table allow-list.

### ⚠️ Bun vs better-sqlite3 (runtime note)
`better-sqlite3` (native) **cannot dlopen under Bun** (`ERR_DLOPEN_FAILED`; Bun issue #4290). This is
fine for runtime: the dev server (`bun run dev`) delegates to the `vite` bin which has a
`#!/usr/bin/env node` shebang → **Node runs Vite's SSR**, where better-sqlite3 loads; prod is
`node .output/server/index.mjs` (Node). Only the **test runner** was affected → the auth/DB
integration tests run under **vitest (Node)**; the framework-agnostic `shared/` tests stay on `bun test`.
Verified: `node -e "require('better-sqlite3')..."` → ok; `bun -e "..."` → ERR_DLOPEN_FAILED.

## Provisioning + Billing — REAL code paths, ENV-GATED (inert without creds)

Both clients are **lazy-initialised** behind env guards — nothing is constructed at module load, so the
server boots and landing+auth+dashboard work with **zero credentials** (verified by `env-gating.test.ts`).

- **Cloudflare for SaaS** (`src/lib/provision/cloudflare.ts`): `provisionManagedSubdomain(name)` calls
  the CF custom-hostnames API when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` are set; otherwise
  returns `{ configured:false }` **demo mode** (reserves a real-shaped `<name>.devdashboard.app` in the
  DB but nothing live on the edge). Returns the exact `{ hostname, routing:{target}, vendorFronted }`
  shape the agent's `requestManagedSubdomain` (in `src/dev-dashboard/lib/tunnel/cloudflared.ts`) expects.
- **Stripe** (`src/lib/billing/stripe.ts`): `getStripe()` returns null without `STRIPE_SECRET_KEY`.
  `createCheckoutSession` / `createPortalSession` / `constructWebhookEvent` all inert+graceful when
  unconfigured. Webhook (`/api/stripe/webhook`) verifies the signature on the RAW body and maps
  `checkout.session.completed` + `customer.subscription.updated/deleted` onto the subscription row.

### Device-code pairing (managed tier)
The wizard's "pair device" step records a device's **PUBLIC key only** after the user enters the
out-of-band **device code** printed by `tools dev-dashboard pair` (agent side,
`src/dev-dashboard/server/routes/e2e.ts`). The cloud never validates/decrypts the pairing secret — the
real E2E handshake (X25519 ECDH → per-message AEAD, D9/D29) happens phone↔Mac, never through the cloud.

## Required environment variables (all in `.env.example`; never committed)

| Var | Required? | Purpose |
|-----|-----------|---------|
| `NODE_ENV` | no (default `development`) | env mode |
| `DD_CLOUD_APP_URL` | no (default `http://localhost:7251`) | auth callbacks + Stripe redirect URLs |
| `DD_CLOUD_MANAGED_DOMAIN` | no (default `devdashboard.app`) | apex managed domain |
| `DD_CLOUD_DATABASE_URL` | no (default `./data/cloud.db`) | SQLite path (or PG conn string when driver=postgres) |
| `DD_CLOUD_DATABASE_DRIVER` | no (default `sqlite`) | `sqlite` \| `postgres` |
| `DD_CLOUD_AUTH_SECRET` | **prod yes** | Better-Auth session signing (dev fallback used if unset) |
| `DD_CLOUD_BIND_HOST` | no (default `127.0.0.1`) | dev-server bind host |
| `STRIPE_SECRET_KEY` | optional | enables billing |
| `STRIPE_WEBHOOK_SECRET` | optional | webhook signature verification |
| `STRIPE_PRICE_PRO_MONTHLY` / `_PRO_YEARLY` / `_TEAM_MONTHLY` | optional | Checkout price ids |
| `CLOUDFLARE_API_TOKEN` | optional | enables managed-subdomain provisioning |
| `CLOUDFLARE_ZONE_ID` | optional | zone of the managed apex domain |
| `CLOUDFLARE_FALLBACK_ORIGIN` | no (default `fallback.devdashboard.app`) | CNAME target for custom hostnames |

## Mocked-vs-real matrix

| Capability | Without creds (default) | With creds |
|------------|-------------------------|------------|
| Landing / auth / dashboard render | **real** (no creds needed) | real |
| Sign up / sign in / session | **real** (Better-Auth + SQLite) | real |
| DB (accounts/devices/subdomains/subscriptions/settings) | **real** SQLite | real (SQLite or Postgres) |
| Managed-subdomain claim | **demo mode** — reserved in DB, real-shaped hostname, NOT live on CF edge | **real** CF custom hostname |
| Device pairing (record PUBLIC key) | **real** (DB write) | real |
| Stripe checkout / portal | **inert** — "not configured" notice, no redirect | **real** Checkout/Portal redirect |
| Stripe webhook | 200-acks, no-op | **real** signature-verified subscription sync |

## Verification

- **tsc** (`bun run check-types`): clean (cloud web) + repo-level `tsgo` clean for the commander entry.
  (Pre-existing repo errors in `src/dev-dashboard/lib/e2e/box.ts` [`tweetnacl`] and `mdns-advertiser.ts`
  are on the base branch, not introduced here — those deps aren't installed on this branch.)
- **Biome**: clean (`@theme` CSS excluded; `useUniqueElementIds` off for intentional anchor ids).
- **Tests** — shared layer `bun test ../shared`: **11 pass** (tier-policy 6, data-boundary 5).
  Node layer `vitest run`: **6 pass** (auth integration 3 [signup persists / wrong-pw rejected /
  correct-pw signs in], env-gating 3 [Stripe inert / CF demo-mode / invalid-name reject]).
- **Build** (`bun run build`): clean — client + SSR + Nitro bundles.
- **Playwright (port 7251):** dev server started clean (VITE ready ~0.9s). curl probes:
  `GET /` 200, `/signin` 200, `/signup` 200, `/dashboard` 200, `/api/auth/get-session` 200; landing
  SSRs the full 45 KB page with hero/trust/pricing copy from tier-policy. Playwright-mcp navigated to
  the landing and captured the accessibility snapshot showing the correct title, hero heading
  ("Your machine, streamed to your phone — and we can't see your data."), nav, and CTAs.
  **PARTIAL — orchestrator should finish the sweep.** The signup→dashboard *click-through* was NOT
  completed: mid-verification the backgrounded `bun run dev | tee` pipe stalled the tool layer (the
  `tee`+background foot-gun CLAUDE.md warns about), and the dev server was then killed. What IS
  verified: all routes return correct status (`/` 200, `/signin` 200, `/signup` 200, `/dashboard`
  **307 redirect to /signin when anon** = auth protection works, `/api/auth/get-session` 200 → `null`
  for anon), landing SSRs the full ~48 KB page with hero/trust/pricing copy from tier-policy, and
  Playwright rendered the landing with the correct title + hero. **Orchestrator: run the full
  playwright sweep** (signup → land on /dashboard → wizard → claim subdomain → pair device → settings
  → billing) and re-screenshot. The dev server on 7251 is **already stopped** (port free, verified).
  - **Known cosmetic issue:** Playwright logged a **React hydration mismatch** on the landing — the
    scroll-reveal bootstrap script adds the `.in` class to `.reveal` elements before React hydrates,
    so the SSR markup (`reveal …`) differs from the first client render (`reveal … in`). Cosmetic
    (content renders fine), but it's a real hydration warning. Fix later by gating the reveal class on
    a post-hydration `useEffect` flag, or rendering `.in` server-side and animating purely via CSS.

## What needs the user (real credentials / infra)

1. **Cloudflare for SaaS account** — `CLOUDFLARE_API_TOKEN` (scoped to the managed zone: SSL+Certs
   Edit, DNS Edit) + `CLOUDFLARE_ZONE_ID` for `devdashboard.app` (+ DNS for the apex/wildcard). Until
   then, managed-subdomain claim runs in demo mode.
2. **Stripe** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the three price ids. Configure a
   webhook endpoint → `/api/stripe/webhook`. Until then, billing is inert (plans shown, checkout off).
3. **`DD_CLOUD_AUTH_SECRET`** — generate one for any non-dev deploy (`openssl rand -base64 32`).
4. **Deploy target** — the app builds to a Nitro server (`node .output/server/index.mjs`). For
   multi-tenant prod, set `DD_CLOUD_DATABASE_DRIVER=postgres` and wire the Postgres branch
   (add `pg` + `schema.pg.ts` mirror in `src/lib/db/index.ts`) + run migrations as a deploy step.
5. **Confirm the auth direction** — if "WorkOS" was the intended answer (not Better-Auth), swap the
   single `auth.server.ts` adapter per the flag above.
6. **Confirm the worktree base** — `10981acc5` (see the worktree-base flag at the top).

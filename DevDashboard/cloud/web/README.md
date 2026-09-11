# DevDashboard Cloud — Web

The managed-tier web app for [DevDashboard](../../README.md): the marketing landing page,
authentication, and the customer dashboard where you choose a plan, claim a managed subdomain,
pair devices, and manage billing.

> **What this is not.** This app never streams your terminals or metrics — that's the
> [DevDashboard Agent](./docs/install-the-agent.md) on your Mac talking to the mobile app.
> Cloud only handles accounts, plans, managed subdomains, and device **public-key** registration.
> By design it can't see your data — see [Security & Trust](./docs/security-and-trust.md).

---

## Stack

| Concern | Choice |
|---|---|
| Framework | [TanStack Start](https://tanstack.com/start) `^1.168` (file-based routes) |
| Server | [Nitro](https://nitro.build/) (via `nitro/vite`) |
| UI | React 19.2, Tailwind v4 (`@tailwindcss/vite`), Vite 8 |
| Auth | [Better-Auth](https://better-auth.com/) (email + password) |
| ORM / DB | [Drizzle](https://orm.drizzle.team/) on SQLite (better-sqlite3), Postgres-ready |
| Billing | [Stripe](https://stripe.com/) (optional — inert without keys) |
| Provisioning | Cloudflare for SaaS custom hostnames (optional — inert without keys) |
| Lint | Biome 2.2.4 |
| Tests | Vitest (node) + `bun test` (shared) + Playwright (e2e) |

Design system: this surface intentionally uses the **Obsidian Terminal** look (dark, double-bezel
cards, mono eyebrows, emerald/violet accents) — not the GenesisTools shared shadcn UI. The raw
`zinc-*` / `white/[0.0x]` Tailwind classes here are correct, not a violation. See
`src/styles/app.css` for the tokens and `src/components/dashboard/Card.tsx` for the `Card` /
`SectionTitle` primitives.

---

## Quickstart

From a clean clone, with [Bun](https://bun.sh) installed:

```bash
# 1. From DevDashboard/cloud/web/
bun install

# 2. Create the SQLite DB and apply migrations (REQUIRED — see the gotcha below)
bun run db:migrate

# 3. Start the dev server on http://127.0.0.1:7251
bun run dev
```

Open <http://127.0.0.1:7251>. The landing page, sign-up, sign-in, and dashboard all work with
**zero secrets** — Stripe and Cloudflare are optional and degrade to a "not configured" demo state
when absent.

> **Gotcha — run `db:migrate` before the first sign-up.** Better-Auth's Drizzle adapter writes to
> the `user`/`account` tables directly and does *not* auto-create them. Skipping `db:migrate` makes
> the first sign-up 500 with `no such table: user`. See
> [Troubleshooting](./docs/troubleshooting.md#signup-500--no-such-table-user).

---

## Scripts

```bash
bun run dev           # vite dev --port 7251 --host ${DD_CLOUD_BIND_HOST:-127.0.0.1}
bun run build         # vite build -> .output/
bun run start         # node .output/server/index.mjs (production server)
bun run check-types   # tsc --noEmit

bun run test          # bun test ../shared && vitest run  (shared + node units)
bun run test:node     # vitest run (node env, src/**/*.test.ts)
bun run test:shared   # bun test ../shared (data-boundary + tier-policy)

bun run db:generate   # drizzle-kit generate (new migration from schema changes)
bun run db:migrate    # drizzle-kit migrate (apply pending migrations)
bun run db:push       # drizzle-kit push (dev-only: push schema without a migration)
```

### End-to-end tests

Playwright drives a real browser against a dev server with a dedicated, **throwaway** test DB
(`./.e2e/cloud-e2e.db`, gitignored). The global-setup migrates it before the server boots, so e2e
never touches your dev or prod DB.

```bash
bun run test:e2e      # playwright test
bun run test:e2e:ui   # playwright test --ui
```

---

## Environment

All config is read in one place: [`src/lib/server/env.ts`](./src/lib/server/env.ts). Copy the
template and fill in what you need:

```bash
cp .env.example .env
```

| Var | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Standard. |
| `DD_CLOUD_APP_URL` | `http://localhost:7251` | Public base URL (auth callbacks + Stripe redirects). |
| `DD_CLOUD_DATABASE_URL` | `./data/cloud.db` | SQLite file path (relative resolves from `web/`). |
| `DD_CLOUD_DATABASE_DRIVER` | `sqlite` | Set to `postgres` to swap the dialect (see seam below). |
| `DD_CLOUD_AUTH_SECRET` | dev-only fallback | Session-signing secret. **Required in production** — `openssl rand -base64 32`. |
| `DD_CLOUD_MANAGED_DOMAIN` | `devdashboard.app` | Apex for managed subdomains. |
| `DD_CLOUD_BIND_HOST` | `127.0.0.1` | `0.0.0.0` to expose on LAN / behind a tunnel. |
| `STRIPE_*` | unset | Optional. Billing is inert (demo state) without these. |
| `CLOUDFLARE_*` | unset | Optional. Managed-subdomain provisioning is inert without these. |

When Stripe or Cloudflare vars are absent, the server still boots and the relevant pages render a
graceful "not configured" state — see [Troubleshooting](./docs/troubleshooting.md).

---

## Architecture seams

Two deliberate swap points keep the app simple now and portable later:

- **SQLite → Postgres.** [`src/lib/db/index.ts`](./src/lib/db/index.ts) is the single DB access
  point. Today it opens better-sqlite3 (WAL + foreign keys on). Setting
  `DD_CLOUD_DATABASE_DRIVER=postgres` swaps the dialect; Postgres migrations run out-of-band in CI
  / deploy (not on boot — see [`migrate.ts`](./src/lib/db/migrate.ts)).
- **Better-Auth → WorkOS.** [`src/lib/auth/auth-service.ts`](./src/lib/auth/auth-service.ts) is a
  thin seam exposing `getSessionUser()`, `requireAuth()`, and `handler()`. App code only ever calls
  *this* — never Better-Auth directly — so the provider can be swapped without touching routes or
  server functions.

The **data boundary** ([`../shared/data-boundary.ts`](../shared/data-boundary.ts)) is the
non-negotiable invariant: every write into a cloud table passes through `assertNoKeyMaterial`, which
rejects any private-key field and any field outside the per-table allow-list. The cloud stores
**public keys only**. Full explanation in [Security & Trust](./docs/security-and-trust.md).

---

## Routes

| Path | Auth | What |
|---|---|---|
| `/` | public | Landing: hero, trust story, features, pricing. |
| `/signin`, `/signup` | public | Better-Auth email/password. `/signup?plan=pro\|team\|free`. |
| `/dashboard` | required | Overview: plan / devices / subdomain + a 4-step checklist. |
| `/dashboard/setup` | required | Claim a managed subdomain + pair a device. |
| `/dashboard/devices` | required | Paired devices (list + remove). |
| `/dashboard/settings` | required | Push-alert preferences. |
| `/dashboard/billing` | required | Current tier + upgrade / manage. |
| `/api/auth/*` | n/a | Better-Auth catch-all. |
| `/api/stripe/webhook` | sig-gated | Stripe webhook (inert 200 ack when unconfigured). |

---

## Product docs

These guides are written for users (and the people deploying for them):

- **[Getting Started](./docs/getting-started.md)** — sign up → plan → subdomain → agent → pair → verify → live.
- **[Install the Agent](./docs/install-the-agent.md)** — run the Mac agent, pick a transport, pair your phone.
- **[Pricing & Tiers](./docs/pricing-and-tiers.md)** — Free / Pro / Team and the trust-tier matrix.
- **[Troubleshooting](./docs/troubleshooting.md)** — the common failure modes and their fixes.
- **[Security & Trust](./docs/security-and-trust.md)** — what the cloud can and can't see, and how to verify it.

Product hub & strategy live one level up: [`../../README.md`](../../README.md),
[`../../PRODUCT-ROADMAP.md`](../../PRODUCT-ROADMAP.md), [`../../DECISIONS.md`](../../DECISIONS.md).

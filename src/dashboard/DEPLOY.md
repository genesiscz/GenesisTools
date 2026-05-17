# Dashboard — Self-Hosted Deployment (Node 22 + PM2)

Single web process (`apps/web`, TanStack Start on its embedded Nitro server)
behind a reverse proxy.

## Prerequisites

- Node **22** (`.node-version` pins it). `better-sqlite3` is a native module compiled
  against the Node ABI — if the host Node differs, run
  `bun install && npm rebuild better-sqlite3` on the host.
- PM2, a reverse proxy (nginx/Caddy) for TLS + a single public port.

## Environment

Copy `apps/web/.env.example` and fill it (or set via the PM2 ecosystem env block).
All `WORKOS_*` vars are **required** — the server fails fast at boot (`src/lib/env.ts`)
if any is missing/invalid, instead of silently running auth-broken.

`SQLITE_PATH` and `MIGRATIONS_DIR` **must be absolute** in production. A relative
`SQLITE_PATH` resolves against the PM2 cwd and silently opens a *different, empty*
DB — indistinguishable from total data loss. The app throws at boot if
`NODE_ENV=production` and `SQLITE_PATH` is relative.

## Pre-production secret rotation (REQUIRED — do before first prod deploy)

The development `apps/web/.env` (gitignored, NOT in this branch's worktree)
contained a **live** WorkOS API key and stale Neon Postgres credentials. The
app is SQLite-only now — the Neon `DATABASE_URL` lines are dead config that
mislead operators. Plaintext-on-disk secrets must be treated as compromised.

- [ ] Rotate the WorkOS API key: https://dashboard.workos.com → API Keys → roll. Put the new key in the secrets store / PM2 ecosystem env, never in git.
- [ ] Delete the stale `DATABASE_URL` / Neon lines from `apps/web/.env` (SQLite-only).
- [ ] If a Neon project still exists, disable that role (the password was on disk).
- [ ] Confirm no env file is tracked: `git ls-files | grep 'apps/web/\.env'` → only `.env.example`.

## Build

```bash
cd /opt/dashboard/src/dashboard
bun install
bun run build:prod    # = turbo run build --filter=@dashboard/web → apps/web/.output/
```

`check-types` is a `turbo.json` build dependency and `apps/web` defines it
(`tsc --noEmit`; web uses `tsconfig.build.json` which excludes tests), so a
type-broken tree fails the build instead of shipping. Use `bun run build:prod`
(`turbo run build --filter=@dashboard/web`) for the web-only deploy build.

## Migrations

Migrations run **automatically at server boot** (`src/drizzle/index.ts` calls
`migrate()` before the first query; it refuses to serve on migration failure).
No manual step. `MIGRATIONS_DIR` must point at the on-disk
`apps/web/src/drizzle/migrations` folder (kept with the source tree on the host).

## First deploy — one-time DB move

If you ran the app before this hardening, the DB was at a **relative**
`.data/dashboard.sqlite`. Move it to the new absolute path *before* first boot,
or the app creates a fresh empty DB:

```bash
mkdir -p /opt/dashboard/data
mv /path/to/old/.data/dashboard.sqlite* /opt/dashboard/data/   # incl. -wal/-shm
```

## Run

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

**Fork mode, single instance is mandatory** (see header comment in
`ecosystem.config.cjs`): the SSE event bus and the single SQLite writer are
per-process. Cluster mode silently breaks realtime and increases write
contention. Horizontal scaling is not supported with this architecture.

## Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl;
  server_name your.domain;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # SSE (/api/events, /api/timer-events) must not be buffered.
    proxy_buffering off;
    proxy_cache off;
  }

  location /assets/ {
    proxy_pass http://127.0.0.1:3000;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
}
```

## Health

`GET /api/health` runs `SELECT 1` against SQLite → `200 {status:"ok"}` or `503`.
Use it for PM2 / uptime monitoring (distinguishes "process up" from "DB ok").

## Graceful shutdown

`drizzle/index.ts` registers SIGTERM/SIGINT handlers that close the SQLite
handle before exit (PM2 sends SIGTERM on reload/stop). SIGTERM waits ~3s for
in-flight requests / SSE to drain before closing; `ecosystem.config.cjs` sets
`kill_timeout: 8000` so PM2 does not SIGKILL during that drain.

## Accepted risks (explicit product decisions — NOT bugs)

- **No database backups.** A single SQLite file with no replication. One bad
  disk / wrong `rm` / corrupt WAL = unrecoverable. Owner accepted this; revisit
  if data becomes valuable (Litestream sidecar is the recommended add-on).
- **No horizontal scaling.** Fork mode, one instance, by design.
- **Open signup, unthrottled.** Anyone reaching the URL can create an account
  (they get isolated data). No signup rate-limiting. Acceptable for a trusted
  group; add a rate-limit / allowlist if exposed more broadly.

## Deploy side-effect

This hardening replaced the localStorage auth session with a server httpOnly
cookie. The first deploy invalidates any existing client sessions — users will
need to sign in again. Expected, one-time.

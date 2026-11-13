# tools dashboard

`tools dashboard` starts the personal productivity dashboard: a local web app for timers, tasks, focus sessions, a
day planner, habits, goals, notes and more, stored in one SQLite file on disk. The bare command installs the app's
dependencies when they are missing, runs the server in the background, and opens it in the browser. Every page needs
a WorkOS sign-in, so create the environment file first.

## Quick start

```bash
# One time, from the GenesisTools checkout: create the env file, then fill in the four WORKOS_* values
cp src/dashboard/apps/web/.env.example src/dashboard/apps/web/.env.local

# Install dependencies if needed, start the dev server in the background, open http://localhost:3000/
tools dashboard

# Is it running? Prints pid, port, uptime, dependencies and launchd state
tools dashboard status

# Read the background server log (last 200 lines), or follow it live
tools dashboard logs
tools dashboard attach

# Stop it
tools dashboard down

# Keep it running across reboots (macOS launchd agent)
tools dashboard install
```

`.env.example` is written for a production host. In `.env.local`, delete its `SQLITE_PATH`, `MIGRATIONS_DIR` and
`NODE_ENV=production` lines, so dev uses the default database path. The WorkOS values need a WorkOS account; for a
local run without one, see **Auth** under How it works.

Only the bare `tools dashboard` runs `bun install` when `src/dashboard/node_modules` is missing. Pass `--no-install`
to get an error instead. The subcommands (`up`, `restart`, `open`, `install`) only warn that `node_modules` is
missing, name the fix (`bun install` in `src/dashboard`, or the bare command), and try to start the server anyway.

## Commands

### The bare command

`tools dashboard [options]` makes sure the dependencies are in place, then starts the server the same way as `up`
(in the background, browser opens).

| Flag | What it does |
|------|--------------|
| `--prod` | Production build, then run it under PM2 instead of the dev server |
| `--reinstall` | Run a fresh `bun install` before starting |
| `--no-install` | Do not install when `node_modules` is missing; exit 1 |
| `--no-open` | Start the server, do not open a browser |
| `-p, --port <number>` | Port to wait on and open (default `3000`, see Troubleshooting) |
| `-v, --verbose` | Verbose logging |
| `--readme` | Print this README |

### Lifecycle

| Command | What it does |
|---------|--------------|
| `up` | Start in the background and open the browser |
| `down` (alias `stop`) | Stop the running instance |
| `restart` | Stop, then start fresh |
| `status` | Print pid, port, uptime, dependencies and launchd state |
| `open` | Print the URL and open the browser |

`up` and `restart` take the same flags:

- `-f, --foreground`: block until killed, instead of running in the background.
- `-p, --port <n>`: the port to wait on and open. The server stays on 3000 (see Troubleshooting).
- `--force`: kill a process that holds the port before starting.
- `--no-open`: do not open a browser.
- `-i, --interactive`: accepted, but no code reads it, so it does nothing. A menu appears only in a terminal, and
  only when the port is already held (by this dashboard or by another process).

`down` takes `--no-force`: do not escalate to SIGKILL after the grace period.

`open` takes these flags:

- `-p, --port <n>`: the port to check and open. The server stays on 3000 (see Troubleshooting).
- `--no-open`: print the URL only. It does not wait for the page and does not open the browser.
- `-q, --query <key=value>`: add a URL query parameter. Repeat it for more than one.
- `--no-qr`: accepted, but it changes nothing here. This dashboard has no QR access config, so `open` never prints a
  QR code.

When the dashboard is stopped, `open` in a terminal asks "Start it now?" and starts it after a yes. In a
non-interactive shell (a script, an agent) it prints `error: Personal Dashboard is not running on port 3000.` and
exits 1.

### Logs

| Command | What it does |
|---------|--------------|
| `logs` | Print the last lines of the background log |
| `attach` | Print the last lines, then follow the log |

- `logs -n, --lines <n>`: how many lines (default 200).
- `attach -n, --lines <n>`: how many lines to print first (default 50). Ctrl+C stops the tail; the server keeps
  running.

### Start at login (macOS)

| Command | What it does |
|---------|--------------|
| `install` | Register a launchd agent: the dashboard survives a reboot and respawns after a crash |
| `uninstall` | Unload the agent, kill the process on port 3000, remove the plist |

- `install --force`: kill a process that holds the port before installing.
- `install -p, --port <n>`: the port to wait on. The server stays on 3000 (see Troubleshooting).
- `uninstall` kills whatever process holds the dashboard's port, even when it is another app. Stop that app first if
  it is not the dashboard.

The first `up` in a terminal asks once whether to install the launchd agent. The answer is saved, so it does not ask
again.

## What the app does

The sidebar has three groups. Each page reads and writes the same SQLite database.

- **Dashboard and Timer** (`/dashboard`, `/timer`): stopwatch, countdown and Pomodoro timers, synced between tabs and
  devices.
- **Assistant** (`/assistant/...`): tasks with a kanban board, "what's next", context parking, a decision log,
  a communication log, blockers, handoffs, analytics and badges.
- **Personal tools** (`/dashboard/...`): AI assistant chat, focus mode, quick notes, bookmarks, a daily planner
  (day timeline), habits, goals and OKRs, a mood journal, expenses and a reading list.
- **Settings** and **Profile** (`/settings`, `/profile`).

## How it works

- **Workspace.** `src/dashboard/` is a Bun and Turborepo monorepo. `apps/web` is the real app: TanStack Start
  (React 19) on its embedded Nitro server, with Node 22 SSR, not Bun. `packages/shared` holds shared code
  (`SafeJSON`, types, constants). `.node-version` pins Node 22.
- **Launcher.** `tools dashboard` runs `bun run dev` in `src/dashboard`, which is `turbo run dev` for
  `@dashboard/web`, which is `vite dev --port 3000 --host $DASHBOARD_BIND_HOST` (default `127.0.0.1`). The process
  is managed by the shared DashboardApp lifecycle (`src/utils/DashboardApp/`), the same one other GenesisTools
  dashboards use.
- **Database.** Drizzle ORM over `better-sqlite3`. The calls are synchronous. The file is `SQLITE_PATH`, default
  `.data/dashboard.sqlite` relative to the server's working directory (in dev that is
  `src/dashboard/apps/web/.data/dashboard.sqlite`). The server opens it in WAL mode with foreign keys on and a 5 s busy
  timeout. Migrations apply at server start; a failed migration means the server refuses to serve. See
  [database.md](apps/web/.claude/docs/systems/database.md).
- **The server is the source of truth.** The browser holds no database and there is no offline sync.
- **Realtime.** Two layers. A per-user in-memory SSE event bus (`/api/events`, plus `/api/timer-events` for timers)
  reaches other devices. BroadcastChannel reaches other tabs on the same device. Both only tell TanStack Query to
  refetch. See [events.md](apps/web/.claude/docs/systems/events.md).
- **Auth.** WorkOS AuthKit (`@workos/authkit-tanstack-react-start` on every request, plus `@workos-inc/node`), with
  the environment validated by `@t3-oss/env-core` in `apps/web/src/lib/env.ts`. Every page needs a sign-in: a visitor
  who is not signed in is sent to `/auth/signin`, and every server function answers 401. For a local run without a
  WorkOS account, set `E2E_AUTH_BYPASS=1` (server) and `VITE_E2E_AUTH_BYPASS=1` (client). They skip WorkOS and act
  as the user `dev-user`. Both are ignored when `NODE_ENV=production`, and Playwright sets both. The four `WORKOS_*`
  variables must still hold values of the right shape; `apps/web/playwright.config.ts` uses dummy ones. A few client
  hooks (the timer, habits) also fall back to the id `dev-user` in dev, but that does not skip the sign-in.
- **Cost.** The AI assistant chat (`/api/ai-chat`) calls the Anthropic API with `ANTHROPIC_API_KEY`, which bills that
  key. Without the key the route answers HTTP 503. Nothing else in the app spends money.
- **Avatars.** A profile picture upload writes the image to disk (see Files on disk) and sets the user's WorkOS
  profile picture to this server's `/api/avatar/<userId>` URL.
- **Health.** `GET /api/health` runs `SELECT 1` against SQLite and answers `200 {status:"ok"}` or `503`.

A no-account local run from a shell (the dashboard must be stopped, so that this shell starts the server):

```bash
E2E_AUTH_BYPASS=1 VITE_E2E_AUTH_BYPASS=1 tools dashboard
```

The launchd agent does not get these two variables: its plist carries only the launcher's own environment.

### Files on disk

| Path | What it holds |
|------|---------------|
| `src/dashboard/apps/web/.data/dashboard.sqlite` | The database in dev (plus `-wal` and `-shm`) |
| `src/dashboard/apps/web/.data/avatars/` | Profile avatars in dev, one `<userId>.<ext>` each |
| `~/.genesis-tools/dashboards/dashboard.pid` | The pid of the background server |
| `~/.genesis-tools/dashboards/dashboard.config.json` | Saved preferences (see Configuration) |
| `~/.genesis-tools/logs/dashboard.bg.log` | The background server's stdout and stderr |
| `~/Library/LaunchAgents/com.genesis-tools.dashboard.plist` | The launchd agent, after `install` |

The avatars folder is `.data/avatars` under the server's working directory. It does not follow `SQLITE_PATH`, so
under PM2 it is `/opt/dashboard/src/dashboard/.data/avatars/`, apart from the database. Move it or back it up on its
own.

The dashboards registry (`src/utils/ui/dashboards.ts`) lists this app as `personal-dashboard` on port 3000, not as
`dashboard`: the browser router turns every registry key into a host name, and the short name stays free for a user's
own alias.

## Configuration

### Preferences file

`~/.genesis-tools/dashboards/dashboard.config.json` is written by the lifecycle commands. You can edit `bindHost`.

| Key | Meaning |
|-----|---------|
| `bindHost` | Listen address. Default `127.0.0.1` |
| `launchdInstalled` | `install` succeeded |
| `launchdPromptDismissed` | You answered no to the first-run launchd question |
| `launchdServe` | The serve mode `install` chose |

`"bindHost": "0.0.0.0"` opens the dashboard to the LAN (a phone, a tunnel) and makes the browser URL the LAN address.
The launcher passes the listen address to the server as `DASHBOARD_BIND_HOST`.

### Environment

The web app reads these from its process environment: the PM2 `env_production` block in `ecosystem.config.cjs` in
production, and `apps/web/.env.local` in dev (as the app's agent notes say). [.env.example](apps/web/.env.example)
lists most of them.

| Variable | Required | Meaning |
|----------|----------|---------|
| `WORKOS_API_KEY` | yes | WorkOS API key |
| `WORKOS_CLIENT_ID` | yes | WorkOS client id |
| `WORKOS_REDIRECT_URI` | yes | A URL, for example `https://dash.example.com/auth/callback` |
| `WORKOS_COOKIE_PASSWORD` | yes | At least 32 characters |
| `NODE_ENV` | no | Default `development`. See `production` below |
| `SQLITE_PATH` | no | Database file. Absolute in production |
| `MIGRATIONS_DIR` | no | Migrations folder. Absolute in production |
| `ANTHROPIC_API_KEY` | no | Turns on the AI chat |
| `MCP_BEARER_TOKEN` | no | Turns on `/mcp` with `MCP_USER_ID`. At least 16 characters |
| `MCP_USER_ID` | no | The user that `/mcp` acts as |
| `PORT` | no | Nitro listens on `NITRO_PORT` or `PORT` in production |
| `DASHBOARD_DEVTOOLS` | no | `1` turns on the TanStack devtools Vite plugin |
| `E2E_AUTH_BYPASS` | no | `1` skips WorkOS on the server and acts as `dev-user` |
| `VITE_E2E_AUTH_BYPASS` | no | `1` skips the sign-in redirect in the browser too |

- All four `WORKOS_*` variables are required: `apps/web/src/lib/env.ts` validates them and throws when one is missing
  or invalid, instead of running with broken sign-in. There is no `DATABASE_URL`; the app is SQLite only.
- `NODE_ENV=production` makes a relative `SQLITE_PATH` an error at startup and turns the two bypass variables off.
  The PM2 `env_production` block sets it.
- In dev, `MIGRATIONS_DIR` defaults to the `migrations` folder next to `src/drizzle/index.ts`.
- `DASHBOARD_DEVTOOLS` is read by `apps/web/vite.config.ts` when the dev server starts.

## Production

`tools dashboard --prod` runs `bun run build:prod` (`turbo run build --filter=@dashboard/web`, output in
`apps/web/.output/`) and then `bunx pm2 start ecosystem.config.cjs`. With the browser enabled it waits up to 90 s for
the port before it opens the URL. The build runs `check-types` (`tsc --noEmit -p tsconfig.build.json`) first, so a
type error fails the build instead of shipping.

[DEPLOY.md](DEPLOY.md) is the full self-hosting guide: Node 22, PM2, the nginx config (SSE must not be buffered), the
one-time move of an old relative database, graceful shutdown, and the secret rotation to do before the first
production deploy. The facts that matter most:

- **Fork mode and one instance are mandatory.** The SSE event bus and the single SQLite writer live in one process.
  Cluster mode silently breaks realtime and raises write contention.
- **`SQLITE_PATH` must be absolute in production.** A relative path resolves against the PM2 working directory and
  silently opens a different, empty database. The app throws at startup when `NODE_ENV=production` and the path is
  relative.
- **Graceful shutdown.** On SIGTERM the server waits about 3 s for requests and SSE streams, then closes SQLite.
  `kill_timeout: 8000` keeps PM2 from sending SIGKILL during that wait.
- **Accepted risks, decided on purpose:** no database backups (Litestream is the suggested add-on), no horizontal
  scaling, and open, unthrottled sign-up (every account gets its own data).
- **The first deploy of the cookie session** signs every user out once, because the session moved from localStorage
  to a server httpOnly cookie.

## Development

Run these in `src/dashboard/apps/web`:

```bash
bun run db:generate    # drizzle-kit generate: a migration from src/drizzle/schema.ts
bun run db:migrate     # drizzle-kit migrate
bun run db:studio      # Drizzle Studio
bun run check-types    # tsc --noEmit -p tsconfig.build.json
bun run test           # vitest run
```

The vitest suite uses the dev database unless `SQLITE_PATH` points elsewhere. The test files that import
`src/drizzle/index.ts` open `.data/dashboard.sqlite`, run the migrations on it, and insert test rows (they delete
their rows afterwards). To keep the dev data out of it:

```bash
SQLITE_PATH=/tmp/dashboard-test.sqlite bun run test
```

A new table goes in `src/drizzle/schema.ts` (`sqliteTable`; JSON columns are `text`, parsed with `SafeJSON`). After a
mutation, call the broadcast helper so other tabs refetch. [apps/web/.claude/CLAUDE.md](apps/web/.claude/CLAUDE.md)
has the patterns for agents.

## For agents

- The CLI has no `--json` output. `status` prints text; `GET http://localhost:3000/api/health` is the machine check.
- **Start it with `up`, not `open`.** In a non-interactive shell, `open` exits 1 when the dashboard is stopped, and
  `up` on a running dashboard only prints `Already running` with the `restart`, `attach`, `status` and `down`
  commands.
- **Exit codes.** These cases exit 1:
  - `--no-install` while `src/dashboard/node_modules` is missing.
  - An invalid `-p` value.
  - The server exits before it is ready.
  - The page keeps answering a 5xx status (not 502, 503 or 504) for 5 s. The server keeps running.
  - `open` in a non-interactive shell while the dashboard is stopped.
  - `open` when the page does not answer within 10 s (not with `--no-open`).
- A readiness timeout only warns (`Readiness check failed`, `Started anyway`) and exits 0, so check `/api/health`
  after a start. `--prod` exits with the code of a failed `bun install`, `bun run build:prod` or `bunx pm2 start`.
- **MCP endpoint.** `POST /mcp` exposes tasks and timers: `list_tasks`, `create_task`, `update_task`, `delete_task`,
  `list_timers`, `upsert_timer`, `delete_timer`. It needs `MCP_BEARER_TOKEN` and `MCP_USER_ID` set; without them it
  answers 501, and a wrong or missing `Authorization: Bearer <token>` answers 401. Every call acts as `MCP_USER_ID`.
  New tools go in `apps/web/src/lib/mcp/tools/` and register in `server.ts`.
- There is no plugin skill for this tool.

## Troubleshooting

- **`-p 3001` prints `Readiness check failed` and `Started anyway`, then `Skipping browser open`.** The dev script
  pins `vite dev --port 3000`, and the launcher does not pass `-p` to the server, so the server still listens on 3000.
  The launcher polls 3001 for 30 s and warns, then waits 20 s more for the page and skips the browser. Every `-p`
  (the bare command, `up`, `restart`, `install` and `open`) changes only the port the launcher waits on and opens,
  never the port the server listens on. Keep 3000, or edit the `dev` script in `apps/web/package.json`.
- **Every page sends you to `/auth/signin`.** There is no WorkOS session. Sign in, or in dev use the two bypass
  variables (see **Auth** under How it works).
- **`better-sqlite3` fails to load.** It is a native module built for one Node ABI. Before every start the launcher
  loads it under Node in `apps/web`; when that fails it runs `npm rebuild better-sqlite3` there. If the rebuild fails,
  the message says "bun install failed" although the rebuild was the step that failed. If it still does not load, run
  `bun rebuild better-sqlite3` in `src/dashboard`, or `bun install && npm rebuild better-sqlite3` on a deploy host.
- **The server reports an environment error.** One of the four `WORKOS_*` variables is missing or invalid (the cookie
  password needs 32 characters).
- **The database looks empty.** A relative `SQLITE_PATH` resolved against another working directory. Use an absolute
  path, and move an old `.data/dashboard.sqlite*` (with `-wal` and `-shm`) to it before the first start.
- **`--prod` on a laptop.** `ecosystem.config.cjs` pins `cwd` to `/opt/dashboard/src/dashboard` and its log files to
  `/var/log/dashboard/`, and the launcher starts PM2 without `--env production`, so the `env_production` block (with
  `NODE_ENV` and the absolute paths) is not applied. On a host, start it as DEPLOY.md says:
  `pm2 start ecosystem.config.cjs --env production`. PM2 owns that process (name `dashboard-web`), not the
  `down` and `status` commands.
- **The background log grows.** Other dashboards trim their log through the shared Vite config; this app's
  `vite.config.ts` does not load it, so `~/.genesis-tools/logs/dashboard.bg.log` is not trimmed.

## Related

- [tools dev-dashboard](../dev-dashboard/README.md): a different app on port 3042, with web terminals (ttyd), cmux
  session viewing and Obsidian note sharing.
- [DEPLOY.md](DEPLOY.md): production build and self-hosting.
- [apps/web/.claude/CLAUDE.md](apps/web/.claude/CLAUDE.md): architecture summary and context triggers for agents.

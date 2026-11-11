# tools dev-dashboard-cloud

Runs DevDashboard Cloud on your Mac at `http://localhost:7251` and opens it in the browser, so you can develop or demo
it locally. DevDashboard Cloud is the managed-tier web app of DevDashboard (`DevDashboard/cloud/web/` in this
repository): the landing page, sign-up and sign-in, and the customer dashboard for plans, managed subdomains, paired
devices and billing. The tool installs the app's dependencies and keeps its Vite dev server running in the background.

## Quick start

```bash
tools dev-dashboard-cloud                 # install deps if needed, start in the background, open the browser
tools dev-dashboard-cloud status          # pid, port, uptime, launchd state
tools dev-dashboard-cloud logs -n 100     # the last 100 lines of the background log
tools dev-dashboard-cloud restart         # stop it and start it fresh
tools dev-dashboard-cloud down            # stop it
```

The tool does not create the database tables. Before the first sign-up, run this once from the GenesisTools checkout,
or the sign-up fails (see Troubleshooting):

```bash
cd DevDashboard/cloud/web && bun run db:migrate
```

## Commands

### The bare command

`tools dev-dashboard-cloud` with no subcommand is the full start. It is the only form that installs dependencies and
the only form that passes a port to the app.

| Flag                  | Default | What it does                                                        |
|-----------------------|---------|---------------------------------------------------------------------|
| `--no-open`           | opens   | Do not open the browser.                                            |
| `--no-install`        | off     | Exit 1 when `node_modules` is missing, instead of `bun install`.    |
| `--reinstall`         | off     | Run `bun install` again before starting, even when it is installed. |
| `-p, --port <number>` | `7251`  | Start on this port (sets `DD_CLOUD_PORT`), wait on it, open it.     |
| `-v, --verbose`       | off     | Verbose logging.                                                    |
| `--readme`            |         | Print this README and exit.                                         |

Before it starts, it checks that the native `better-sqlite3` module loads. When it does not, it runs
`bun rebuild better-sqlite3` in `DevDashboard/cloud/web/` and checks again.

### Subcommands

| Command                  | What it does                                                                 |
|--------------------------|------------------------------------------------------------------------------|
| `up [-f] [--force]`      | Start in the background. `-f` runs in the foreground until you stop it.      |
| `down` (alias `stop`)    | Stop it: SIGTERM, then SIGKILL after 5 s. `--no-force` skips the SIGKILL.    |
| `restart [-f] [--force]` | `down`, then `up`.                                                           |
| `status`                 | Print pid, port, uptime and launchd state.                                   |
| `attach [-n 50]`         | Print the last N log lines, then follow the log. Ctrl+C stops the tail only. |
| `logs [-n 200]`          | Print the last N lines of the background log.                                |
| `open [-q key=value]`    | Make sure it runs, print the URL, open the browser. `-q` repeats.            |
| `install [--force]`      | Register a launchd agent that starts at login and restarts after a crash.    |
| `uninstall`              | Unload the launchd agent, stop whatever listens on 7251, delete the plist.   |

Details that `--help` does not say:

- `--force` on `up`, `restart` and `install` kills whatever process holds the port before it starts.
- `-i, --interactive` on `up` and `restart` is accepted, but nothing reads it yet.
- `--help` also lists `-p, --port` on `up`, `restart`, `open` and `install`, and `--no-open` on `up`, `restart` and
  `open`. These flags have no effect, because the bare command defines the same names and Commander gives them to it.
  Use the bare command for both: `tools dev-dashboard-cloud -p 7300 --no-open`.
- `open --no-qr` changes nothing: this dashboard shows no QR code.
- `up`, `restart` and `install` do not run `bun install`. When `node_modules` is missing they print a warning, and the
  start then fails. Run the bare command once first.
- With `-f`, the browser does not open. Open `http://localhost:7251` yourself.
- When it already runs, `up` on a terminal offers a menu: open, restart, attach, status, stop or abort. Without a
  terminal, it prints the restart, attach, status and down commands and starts nothing.

## How it works

The tool runs `bun run dev` in `DevDashboard/cloud/web/`. That script is
`vite dev --port ${DD_CLOUD_PORT:-7251} --host ${DD_CLOUD_BIND_HOST:-127.0.0.1}`: a TanStack Start app on Nitro, with
Better-Auth sign-in and a SQLite database. A background start then polls `http://localhost:<port>/` for up to 30 s,
and opens the browser at `http://127.0.0.1:<port>/` when the page answers.

Where things live:

| Path                                                                 | What                                |
|----------------------------------------------------------------------|-------------------------------------|
| `~/.genesis-tools/dashboards/dev-dashboard-cloud.pid`                | The pid of the running server.      |
| `~/.genesis-tools/logs/dev-dashboard-cloud.bg.log`                   | The background and launchd log.     |
| `~/.genesis-tools/dashboards/dev-dashboard-cloud.config.json`        | Saved answers and preferences.      |
| `~/Library/LaunchAgents/com.genesis-tools.dev-dashboard-cloud.plist` | The launchd agent, after `install`. |
| `DevDashboard/cloud/web/node_modules/`                               | The app's own dependencies.         |
| `DevDashboard/cloud/web/data/cloud.db`                               | The app's SQLite database.          |

- **The log.** Every background `up` starts the log file over with a session marker, so the previous run's log is
  gone. The app does not cap the file's size, and `logs` and `attach` read only its last 2 MiB.
- **The database.** `cloud.db` keeps `cloud.db-wal` and `cloud.db-shm` beside it. They are part of the live database
  and hold account data: never delete them to "clean up", and never commit them.
- **Dependencies.** `DevDashboard/cloud/web/` is its own package with its own `bun.lock`, separate from the root
  `node_modules`.
- **launchd.** `up` and the bare command ask on a terminal, while the agent is not installed, whether to install the launchd agent
  (the default is no). A "no" is saved in the config file and stops the question; a cancelled prompt saves nothing, and
  `uninstall` resets it. `restart` never asks. When the agent is installed, `up` and `restart` start the
  agent instead of a second copy. The agent has `RunAtLoad` and `KeepAlive` (respawn after 10 s). `down` unloads the
  agent but keeps the plist, so it starts again at the next login; `uninstall` removes it. When GenesisTools.app is
  built, the agent runs under it and shares its privacy grants. `install` and `uninstall` work on macOS only.
- **Other ways it starts.** The dashboard registry (`src/utils/ui/dashboards.ts`) lists it on port 7251. With the
  GenesisTools browser extension, typing `http://localhost:7251` in the address bar can start it.
  `tools services up dev-dashboard-cloud` starts it too, but a bare `tools services up` or `down` skips it: it is
  outside the services fleet.
- **What it needs.** Bun, and `node` on PATH: the `better-sqlite3` check runs `node -e "require('better-sqlite3')…"`.
- **What costs money.** Nothing by default. Stripe billing and Cloudflare subdomain provisioning stay inert, with a
  "not configured" state in the app, until their keys are set.

## Configuration

The tool has no config file of its own. The per-dashboard file
`~/.genesis-tools/dashboards/dev-dashboard-cloud.config.json` holds:

| Key                      | What                                                               |
|--------------------------|--------------------------------------------------------------------|
| `launchdPromptDismissed` | You answered no to the launchd question.                           |
| `launchdInstalled`       | `install` registered the agent.                                    |
| `bindHost`               | `"0.0.0.0"` or `"127.0.0.1"`. It does not reach this app (below).  |

The app reads its settings from environment variables. The `dev` script in `DevDashboard/cloud/web/package.json` reads
the first two; `DevDashboard/cloud/web/src/lib/server/env.ts` reads the rest:

| Variable                   | Default                 | What                                          |
|----------------------------|-------------------------|-----------------------------------------------|
| `DD_CLOUD_PORT`            | `7251`                  | Listen port. Set it with `-p`, not the shell. |
| `DD_CLOUD_BIND_HOST`       | `127.0.0.1`             | Keep loopback. See the LAN warning below.     |
| `DD_CLOUD_APP_URL`         | `http://localhost:7251` | Base URL for auth and Stripe redirects.       |
| `DD_CLOUD_DATABASE_URL`    | `./data/cloud.db`       | SQLite file, relative to the web folder.      |
| `DD_CLOUD_DATABASE_DRIVER` | `sqlite`                | `postgres` is not wired yet (see below).      |
| `DD_CLOUD_AUTH_SECRET`     | dev fallback            | Session secret. Required in production.       |
| `DD_CLOUD_MANAGED_DOMAIN`  | `devdashboard.app`      | Apex domain for managed subdomains.           |
| `STRIPE_*`, `CLOUDFLARE_*` | unset                   | Optional billing and provisioning keys.       |

The full list, with `.env.example`, is in the [app's README](../../DevDashboard/cloud/web/README.md#environment).

Which environment the app sees depends on how it starts:

- A background start (`tools dev-dashboard-cloud`, `up`, `restart`) passes on your shell's environment.
- ⚠️ Do not open the dev server to the LAN with `DD_CLOUD_BIND_HOST=0.0.0.0`. It speaks plain HTTP, so passwords and
  session cookies cross the network unencrypted. Without `DD_CLOUD_AUTH_SECRET` it also signs sessions with the
  public development fallback, so anyone who reads the repository can forge a session. To reach the app from another
  device, set a unique `DD_CLOUD_AUTH_SECRET`, keep the server on `127.0.0.1`, and put a TLS tunnel in front of it.
- ❗ `DD_CLOUD_PORT` is the exception. The bare command replaces a shell value with its `-p` value (default 7251), so
  `DD_CLOUD_PORT=7300 tools dev-dashboard-cloud` still starts on 7251. With `up` or `restart`, the shell value does reach
  the app, which then listens on 7300 while the tool waits on 7251: it warns `Readiness check failed ... Started
  anyway` after 30 s, and `status` and `down` keep looking at 7251. Use `tools dev-dashboard-cloud -p <port>` instead.
- The launchd agent gets only `HOME`, `PATH` and the variables the tool sets for every dashboard. Your shell's
  `DD_CLOUD_*`, `STRIPE_*` and `CLOUDFLARE_*` values do not reach it, so it always listens on `127.0.0.1:7251`.

## For agents

- There is no `--json` output. Use `status` for the state and `logs -n <N>` for the log.
- Without a terminal nothing prompts: the launchd question is skipped, `open` exits 1 when the app is not running, and
  a port held by another process stops the start unless `up --force` is passed.
- The bare command exits 1 on a bad `--port`, on a missing `node_modules` with `--no-install`, and when
  `better-sqlite3` still fails after the rebuild. A failed `bun install` exits with its own code. A background start
  that dies before it is ready exits 1 and prints the log path.
- `up`, `restart` and the bare command exit 0 when they start nothing because another process holds the port or the
  app already runs, and also after a readiness timeout (`Started anyway`). To learn whether the app runs, check
  `status` or the URL, not the exit code. A failed `bun rebuild better-sqlite3` exits with the rebuild's own code.
- There is no MCP tool and no plugin skill for this tool.

## Troubleshooting

- **The first sign-up returns 500 and the log shows `no such table: user`.** Better-Auth writes to its tables directly
  and does not create them. The app runs its migrations only when its own store is first used, which is after the
  first sign-up. Run `cd DevDashboard/cloud/web && bun run db:migrate` once. More in the app's
  [troubleshooting guide](../../DevDashboard/cloud/web/docs/troubleshooting.md).
- **`up -p 7300` starts on 7251, or `open --no-open` still opens the browser.** The bare command takes those flags
  (see Commands). Use `tools dev-dashboard-cloud -p 7300 --no-open`. `status` and `open` still look at 7251.
- **`up` prints "node_modules is missing" and the start fails.** Only the bare command installs. Run
  `tools dev-dashboard-cloud`, or `bun install` in `DevDashboard/cloud/web/`.
- **"better-sqlite3 still fails to load after rebuild".** The native module does not match the `node` on PATH. Run
  `cd DevDashboard/cloud/web && bun rebuild better-sqlite3`, and check which `node` is first on PATH.
- **"Port 7251 is held by …".** Another process listens there. See it with `lsof -nP -iTCP:7251 -sTCP:LISTEN`, then
  stop it, or run `tools dev-dashboard-cloud up --force` to kill it and start.
- **With the launchd agent installed, `-p` or a shell variable has no effect, and `-p` ends with "Launchd agent did
  not become ready".** The agent always runs on 7251 with no shell variables. Run
  `tools dev-dashboard-cloud uninstall`, then start it in the background.
- **"Skipping browser open" after you set `bindHost` to `"0.0.0.0"`.** The tool then opens your
  LAN address, but the app's dev script reads `DD_CLOUD_BIND_HOST`, not the tool's bind host, so it still listens on
  loopback only. Remove `bindHost` and set `DD_CLOUD_BIND_HOST=0.0.0.0` instead.
- **The app fails at start with `DD_CLOUD_DATABASE_DRIVER=postgres`.** The Postgres path is not wired yet, and the
  app refuses to fall back to SQLite. Unset the variable.

## Related

- [The app's README](../../DevDashboard/cloud/web/README.md): stack, scripts, routes, tests and the product guides.
- [DevDashboard](../../DevDashboard/README.md): the product this cloud tier belongs to.
- [tools dev-dashboard](../dev-dashboard/README.md): the self-hosted DevDashboard for your own Mac.
- [tools services](../services/README.md): start and stop the registered servers together.
- [tools browser-extension](../browser-extension/README.md): starts a dashboard when you type its address.
- [tools browser-router](../browser-router/README.md): `tools browser-router ensure 7251` starts it by port.

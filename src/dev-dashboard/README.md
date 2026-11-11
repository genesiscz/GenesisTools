# tools dev-dashboard

A personal web dashboard for your Mac: browser terminals (ttyd and tmux), cmux sessions, agent Q&A and decisions,
annotation boards, Obsidian note sharing, AI account limits, and system panels (ports, processes, disk, containers,
network). It runs at `http://localhost:3042`. A Cloudflare Tunnel can expose it at `https://<your-host>`, and the
DevDashboard mobile app (`DevDashboard/mobile/` in this repo) reaches the same API.

## Quick start

```bash
tools dev-dashboard ui up              # build the UI once and serve it in the background
tools dev-dashboard ui open            # start it if needed, print the URL, open the browser
tools dev-dashboard ui install         # launchd agent: starts at login, respawns on crash
tools dev-dashboard ui dev             # work on the dashboard: Vite dev + HMR in the foreground
tools dev-dashboard share "Notes/Plan.md"   # publish an Obsidian note and copy its public URL
tools dev-dashboard ui status          # pid, port, uptime, dependencies, launchd state
```

## Commands

### Run the server: `ui` (alias `dashboard`)

`tools dev-dashboard ui` with no verb runs `up`. When the dashboard already runs, `up` (bare or named) shows a menu
on a TTY: open in the browser, restart, attach, status, stop. When another process holds the port, it offers to kill
that process. Without a TTY it prints the verbs to run instead. `-i, --interactive` is accepted, but `up()` in
`src/utils/DashboardApp/lifecycle.ts` never reads it, so it changes nothing today.

| Verb | What it does |
|---|---|
| `up` | Start. Background by default. |
| `down` (alias `stop`) | Stop it. Unloads the launchd agent. |
| `restart` | Stop and start fresh. |
| `dev` | Vite dev + HMR in the foreground. |
| `status` | Print pid, port, uptime, dependencies, launchd state. |
| `attach` | Tail the background log. Ctrl+C detaches only. |
| `logs` | Print the last lines of the background log. |
| `open` | Start if needed, print the URL, open the browser. |
| `install` | Register a launchd plist (reboot-safe, respawns). |
| `uninstall` | Remove the plist that `install` wrote. |

Flags:

- `up` and `restart`: `-f, --foreground` (block until killed), `-p, --port <n>`, `--force` (kill a conflicting
  process first), `--no-open`, `-i, --interactive`, `--dev` (run Vite dev + HMR instead of the built bundle).
  `--dev` is ignored with a warning while the launchd agent is installed. Use `ui dev` for one HMR run instead.
- `down`: `--no-force` (do not escalate to SIGKILL after the grace period). `down` unloads the launchd agent but
  keeps the plist, so the agent loads again at the next login. `uninstall` removes the plist.
- `dev`: `-p, --port <n>`, `--no-open`.
- `attach`: `-n, --lines <n>` lines to print first (default 50). `logs`: `-n, --lines <n>` (default 200).
- `open`: `-p, --port <n>`, `--no-qr`, `--no-open` (print the URL only), `-q, --query <key=value>` (repeatable,
  adds a URL query parameter).
- `install`: `--force`, `-p, --port <n>`, `--preview` (register the watch build instead of the built bundle).

Gotchas in these flags:

- `-p, --port` does not move the server. The server always listens on `port` from `config.json`. `-p` changes only
  the port the launcher checks for conflicts, waits on and opens. Without `-p` the launcher uses 3042 from the
  dashboards registry (`src/utils/ui/dashboards.ts`). So `ui up -p 4000` alone starts the server on the
  `config.json` port (3042 by default) and then reports a failed readiness check on 4000. To move the server, set
  `port` in `config.json` and pass the same `-p` to `up`, `restart`, `dev`, `install` and `open`.
- `--no-open` on `up`, `restart` and `dev` changes nothing: the dev-dashboard app config (`ui/app.ts`) turns the
  browser open off. Use `ui open` to open a tab.
- `--no-qr` changes nothing either: dev-dashboard sets no `access.qr`, so `ui open` prints no QR code. The phone
  pairing QR comes from `tunnel setup`.

```bash
tools dev-dashboard ui open -q tab=logs
tools dev-dashboard ui install --preview
```

### Settings and access

```bash
tools dev-dashboard configure                     # alias: config. Set allowed hostnames (needs a TTY)
tools dev-dashboard auth reset                    # new Basic Auth password, printed once
tools dev-dashboard auth reset \
    --username alice \
    --password 'correct-horse'
```

- `configure` edits `allowedHosts`: the hostnames Vite accepts. Empty means Vite allows every host in dev mode.
  While the list stays empty, the Vite dev server asks for hostnames at each start in an interactive terminal. A
  "no" is not saved.
- `auth reset --username <name> --password <password>` saves a new salted hash. The password is generated when you
  omit it. The default username is the one `--help` shows. The change reaches running servers within 30 seconds;
  no restart is needed.

### Share an Obsidian note: `share`

```bash
tools dev-dashboard share "Widgets/Design/2026-08-20-Overview.md"
# prints https://<your-host>/share/<slug> and copies it
tools dev-dashboard share ~/Notes/Vault/Note.md --no-clipboard
```

`share <path>` does the same as the publish and copy buttons in the Obsidian reader. The path is vault-relative or
absolute, and must stay inside the vault. It also takes a source file that sits beside a report, such as
`Report.ts`, and keeps its extension. A path that ends in neither `.md` nor a known source extension gets `.md`
added. `--no-clipboard` prints the URL without copying it. The URL starts with the first entry of `allowedHosts`
(over https), or `http://localhost:<port>` when there is none. Unpublish a note from the dashboard's Obsidian page
(`POST /api/obsidian/unpublish`).

### Remote access and the phone: `tunnel setup`, `pair`, `agent`

```bash
tools dev-dashboard tunnel setup              # guided Cloudflare Tunnel wizard (needs a TTY)
tools dev-dashboard tunnel setup --port 3042  # local port the tunnel points at (default 3042)
tools dev-dashboard pair                      # one-time code that admits a phone to the E2E tier
tools dev-dashboard agent                     # API-only server, no Vite (port 3043)
tools dev-dashboard agent --e2e --no-advertise-mdns
```

- `tunnel setup` installs `cloudflared` with Homebrew when it is missing, opens a browser for the Cloudflare login,
  creates a tunnel named `devdashboard`, routes your hostname to it, writes `~/.cloudflared/<tunnel-id>.yml`, and
  prints a pairing QR and URI for the mobile app. Then run the tunnel with the config file the wizard wrote (or add
  that command as a login service):

  ```bash
  cloudflared tunnel --config ~/.cloudflared/<tunnel-id>.yml run devdashboard
  ```

  The wizard's own hint says `cloudflared tunnel run devdashboard` with no `--config`. cloudflared reads
  `~/.cloudflared/config.yml` by default (`cloudflared tunnel --help`), so that form misses the ingress map in
  `<tunnel-id>.yml`. The wizard also offers a managed `<name>.devdashboard.app` subdomain, but that branch always
  stops with "not available yet": `requestManagedSubdomain()` in `lib/tunnel/cloudflared.ts` throws until the
  DevDashboard Cloud API exists.
- `pair` prints a one-time code. Enter it on the phone within 5 minutes.
- `agent` runs the same API router without the UI. `--port <port>` (default 3043), `--host <host>` (default
  `0.0.0.0`), `--no-advertise-mdns` (skip the Bonjour `_devdashboard._tcp` advert), `--e2e` (accept encrypted
  requests on `POST /api/e2e/rpc`). With `--e2e`, `/api/e2e/rpc` and `/api/e2e/pair` skip Basic Auth: the paired
  key allowlist and the box MAC are the auth for rpc, and pairing carries only public keys.

## The dashboard pages

| Path | What it shows |
|---|---|
| `/` | System pulse: CPU and free memory graphs, weather. |
| `/ttyd` | Browser terminals, each a ttyd page on a tmux session. |
| `/cmux` | cmux workspaces and their sessions. |
| `/qa` | Q&A history and pending forms from `tools question`. |
| `/needs-input-inbox` | Unread action items and live agent terminals. |
| `/boards`, `/boards/<slug>` | Screenshot annotation boards. |
| `/obsidian` | Vault reader with publish and copy. |
| `/ai/accounts` | Every AI provider account, limits, spend. |
| `/daemon` | `tools daemon` tasks and runs. |
| `/build-log-tail` | Live tail of one daemon run's log. |
| `/activity-timeline` | Today's runs, Q&A and terminals by hour. |
| `/containers` | `docker ps -a`. |
| `/disk-janitor` | Disk usage. |
| `/port-killer` | Listening ports, with kill. |
| `/process-monitor` | Processes, with a confirmed kill. |
| `/network-status` | Latency, link quality, Wi-Fi, public IP. |
| `/todos` | Apple Reminders lists. |
| `/tmux-presets` | Save and restore tmux layouts. |
| `/quick-commands` | One-tap command snippets run in tmux. |

`/claude` redirects to `/ai/accounts`.

## How it works

### Serve modes

`ui up` and `ui install` use **static** mode: one Vite build into `~/.genesis-tools/dashboards/dev-dashboard.static/`,
then `vite preview` behind the front proxy. A page load fetches a few bundled assets, which is much faster over the
Cloudflare tunnel than per-module dev requests, and nothing watches files while the server idles. Restart the
server to pick up code changes.

To work on the dashboard, run `ui dev`. It stops the installed server (launchd agent or background instance), runs
Vite dev + HMR in the foreground, and starts the installed server again when you stop it.

To keep a watch mode under launchd instead (`build --watch` + preview: rebuild and page reload on save, bundled
assets over the tunnel), run `ui install --preview`. A later `ui up` or `ui restart` keeps whichever mode the last
`install` chose (`launchdServe` in the preferences file).

On a TTY, the first background `ui up` asks "Install dev-dashboard as a launchd agent so it survives reboots and
restarts on crash?". A yes installs and starts the agent. A no is saved as `launchdPromptDismissed`, and the
question does not come back. `ui restart` never asks.

The APIs (`/api/*`, Obsidian share, ttyd) behave the same in every mode. In code: the harness config is `ui/app.ts`
(`buildDashboardUiServerCmd` from `@genesiscz/utils/DashboardApp`). The serve loop is `runDashboardPreviewUiServer`
in `@genesiscz/utils/DashboardApp/preview`; dev-dashboard only wires the front proxy, the Reminders paths and the
reload hooks in `lib/preview-ui-server.ts`.

### Listen address

dev-dashboard is the one dashboard bound to `0.0.0.0` by default, for the tunnel and for phones on the LAN.
`{ "bindHost": "127.0.0.1" }` in `~/.genesis-tools/dashboards/dev-dashboard.config.json` pins it to loopback. The
same key opens any other dashboard to the LAN.

### Auth

- The UI and the API need Basic Auth, or the session cookie the UI sets after a login.
- The front proxy marks a genuine localhost request (header `x-dd-local-origin`, stripped from inbound requests), so
  the local browser skips the login. Genuine means a loopback client, a Host of `localhost`, `127.0.0.1` or `::1`,
  and no Cloudflare or `x-forwarded-for` header.
- `ui open` opens the LAN address (`http://<LAN IPv4>:3042/`), because dev-dashboard binds `0.0.0.0`. That tab is
  not a localhost request, so it asks for the password. Open `http://localhost:3042` to skip the login. With
  `bindHost` pinned to `127.0.0.1`, `ui open` opens `http://127.0.0.1:3042/` instead.
- When `auth.enabled` is true and no password hash exists, the first request generates a password and saves its
  hash. The password appears once, as the warning line "generated dev-dashboard basic auth password" in the
  background log. Use `auth reset` to choose one.
- A `/share/<slug>` page needs no login: the slug is a random 96-bit token and is the only credential.
- `POST /api/act` passes on its `X-GT-Act-Token` alone, and the token answers one decision letter.

### Public surface

When tunneled (the host, the allowed identities and the tunnel name come from local config, never from this repo):

- `https://<your-host>/` goes through a Cloudflare Access gate (email OTP for the configured identity).
- `https://<your-host>/telegram-webhook` is the `tools telegram-bot` webhook receiver, not the dashboard. An
  anchored tunnel rule routes that one path to its own port. It authenticates with the Telegram secret-token header,
  so it needs no gate. See [telegram-bot](../telegram-bot/README.md).
- `https://<your-host>/share/<slug>` bypasses the gate. Unpublishing revokes the slug.

### Front-proxy upstream timeouts

Cloudflare turns any front-proxy 502 into a public "Bad Gateway", so the deadline the proxy puts on an upstream fetch
is a user-visible setting. `upstreamTimeoutMs()` in `lib/front-proxy.ts` reads the tier of each path from the
endpoint table (`contract/endpoint-table.ts`, the `timeout` of its row). The board streams and the preview reload
stream are not table rows and stay named in `isLongLivedProxiedStream()`.

| Tier | Deadline | Paths |
|---|---|---|
| stream | none | `timeout: "stream"` rows, board streams |
| scan | 120 s | AI spend and Claude usage totals |
| slow | 60 s | ports, pulse, tmux, most gateway reads, tool writes |
| default | 15 s | everything else |

- stream rows: `/api/qa/stream`, `/api/live`, `/api/daemon/runs/tail`, `/api/qa/pending/:id/wait`, plus
  `/api/boards/work/wait` and `/api/boards/*/events`.
- scan rows: `/api/ai/spend/totals`, `/api/ai/spend/series`, `/api/claude/usage/totals`. A cold 30-day spend scan
  takes about 20 s; under the 15 s default it was killed at 15.0 s and answered a 502 (sweep 2026-09-04).
- slow rows, for example: `/api/ports`, `/api/system/pulse`, `/api/system/pulse/history`, `/api/tmux/sessions`,
  most `/api/gateway/*` reads, and the writes that run a tool: `/api/prs/fix`, `/api/prs/merge`, `/api/agents/send`,
  `/api/agents/new`, `/api/agents/voice`, `/api/approvals/answer`, `/api/timesheet/fill`, `/api/vault/clip` and
  `/api/memos/act`. The `timeout` of each row in `contract/endpoint-table.ts` is the full list.

The slow tier is measured, not guessed. Every `TimeoutError` in `~/.genesis-tools/logs/dev-dashboard.bg.log` up to
2026-08-31 12:30 was on one of four paths: `/api/ports` 36, `/api/system/pulse/history` 18, `/api/system/pulse` 4,
`/api/tmux/sessions` 1. Each one was a 502 on the public hostname. They stay bounded rather than joining the stream
tier, because none of them streams and an unbounded fetch holds the proxy connection open forever when the upstream
wedges.

The other 23193 warnings in that log were `AbortError` on `/api/live` and `/api/qa/stream`: a browser closing an SSE
tab, not a gateway fault. `classifyUpstreamFailure()` separates the two, and every 502 the proxy returns logs one
`front proxy: returning 502` line with `reason`, `httpTarget`, `attempts`, `timeoutMs`, `errName`, `errCode` and
`previewRestarting`.

The proxy replays a 502, 503 or 504 response only for GET, HEAD and OPTIONS. A refused connection is retried for
every method, because nothing reached a handler.

### The endpoint table

`contract/endpoint-table.ts` holds one row per non-board endpoint the phone and the web reach:
`{ method, path, policy, timeout }` plus its input and output types. The server binds a row with
`bindEndpoint(row, { input: <zod>, invalid, run })` (`server/bind.ts`), so zod stays in the server. One generic
client method calls any row: `client.call(ENDPOINTS.qaDecisionsDismiss, { session, number, expectedRevision })`.

- `read` changes nothing.
- `keyed-write` answers a retry that carries the same `Idempotency-Key` with its first answer.
- `act` (`POST /api/act`) passes the auth guard on its `X-GT-Act-Token` alone.

### The Mac gateway

The phone reaches the hub through `/api/gateway/*` (`server/routes/gateway.ts`). Each route is one row of the
endpoint table bound to one hub capability (`src/hub/lib/capabilities/index.ts`). `GATEWAY_ROWS` lists all 21:
agents, board, gates, glance, pings, approvals, launch, watching, brief, wake, memos, timesheet, transcript, procs,
stuck, forecast, prompts, promptPrepare, prs, prChecks and widgetSnapshot. The hub door and the gateway mount the
same capability module, so the input check, the defaults and the refusals (`bad-input` is a 400, `not-found` a 404)
are written once. Every capability declares the door rules as typed data (`DoorRules`: never TCC-gated,
interactive, a credential spend or a long-lived child).

`POST /api/gateway/upload` stores one photo or document (PNG, JPEG, WebP, HEIC, PDF, plain text; 20 MB at most)
under `~/.genesis-tools/dev-dashboard/uploads/<day>/`, named by the first 16 hex characters of its SHA-256, and
answers its path. Another content type gets a 415.

### Boards

Screenshot annotation boards, reachable through the HTTP API and the dashboard UI only. The `tools boards` CLI and
the `boards_*` MCP tools were removed (commit `9c9e66ef93`), so no agent interface is left. The templates in
`server/static/boards-templates.md` (also served at `/api/boards/templates.md`) still name the removed MCP tools.

- Routes live under `/api/boards/*`. Static-prefix routes such as `/api/boards/sets/*` and `/api/boards/work/*` are
  registered before the `/api/boards/:slug` catch-all, because the router is first-match.
- Storage: `~/.genesis-tools/dev-dashboard/boards.db` (override with `BOARDS_DB_PATH`), plus a content-addressed
  blob store at `~/.genesis-tools/dev-dashboard/boards/blobs/<sha256[:2]>/<sha256>.<ext>`.
- Live updates go out over `GET /api/boards/:slug/events` (SSE).
- Annotations follow a `staged → open → working → in_review → resolved` status machine, plus `cancelled`. A new
  annotation is `staged` by default, which keeps it out of the work queue until a `dispatch` call
  (`POST /api/boards/:slug/dispatch`) flips it to `open`. A human can review or edit the prompt before an agent
  sees it.

The AI expression layer (`compose`, `arrange`, `update-cards`, `scrape`, `sections`, `questions`; it was 20
`boards_*` MCP tools before the removal) lets an agent present on a board, not just answer. It places batched
markdown, viz, section and question cards in one call, lays them out on the server, reads a structured board digest,
and stages multiple-choice questions that reach the work wire through the same `dispatch` gate as annotations.

- AI-authored cards carry `payload.layer === "ai"` (no schema column).
- Journey sections are `kind: "section"` cards with spatial, not foreign-key, membership.
- Question rows live in `board_questions` (`board_id, card_id, prompt, options, answer, staged, delivered, multi`).
  `delivered` gives the work wire its exactly-once drain.

### What it calls and needs

- **ttyd** at `/opt/homebrew/bin/ttyd` and **tmux** for the terminal pages (`brew install ttyd tmux`).
- **cmux** for the cmux page. The server refreshes its cmux snapshot every `cmuxPollIntervalMs`
  (`server/registry.ts`), but only while a client asked for it in the last 60 s. The page reads that cached
  snapshot every 2 s (`ui/src/routes/cmux.tsx`).
- **docker** for the containers page.
- **Apple Reminders** for the todos page. macOS asks for the Reminders permission on first use.
- **Obsidian vault**: `obsidianVault` in the config, or the vault the shared Obsidian resolver finds.
- **Network**: the weather panel calls `api.open-meteo.com`, the pulse poller calls `api.ipify.org` for the public
  IP, and a shared note page loads its fonts and highlight styles from public CDNs.
- **cloudflared** only for the tunnel.
- No page calls a paid model API. The spend panels compute cost from the agent transcripts on disk.

### Where data lives

| Path | Holds |
|---|---|
| `~/.genesis-tools/dev-dashboard/config.json` | Settings, auth hash, published notes, ttyd sessions |
| `~/.genesis-tools/dev-dashboard/boards.db` | Boards |
| `~/.genesis-tools/dev-dashboard/boards/blobs/` | Board images |
| `~/.genesis-tools/dev-dashboard/pulse.db` | CPU and memory history |
| `~/.genesis-tools/dev-dashboard/commands.json` | Quick commands |
| `~/.genesis-tools/dev-dashboard/uploads/<day>/` | Phone uploads |
| `~/.genesis-tools/dev-dashboard/voice/<day>/` | Phone voice clips for agents |
| `~/.genesis-tools/dev-dashboard/launch-prompts/` | Long prompts for new agents |
| `~/.genesis-tools/cmux/tmux-presets/` | Saved tmux presets |
| `~/.genesis-tools/dev-dashboard/vault-locks/` | Note save locks |
| `~/.genesis-tools/dev-dashboard/tunnel.json` | Tunnel pairing (0600) |
| `~/.genesis-tools/dev-dashboard/e2e-keys.json` | The Mac's E2E key pair |
| `~/.genesis-tools/dev-dashboard/e2e-peers.json` | Paired phone public keys (0600) |
| `~/.genesis-tools/dev-dashboard/pairing-code.json` | The current `pair` code |
| `~/.genesis-tools/dashboards/dev-dashboard.config.json` | Launcher preferences |
| `~/.genesis-tools/dashboards/dev-dashboard.pid` | Pid file |
| `~/.genesis-tools/dashboards/dev-dashboard.static/` | Static build |
| `~/.genesis-tools/logs/dev-dashboard.bg.log` | Background log |
| `~/Library/LaunchAgents/com.genesis-tools.dev-dashboard.plist` | launchd agent |

The background log is capped: the server trims it in place when it passes 10 MB and keeps the last 1 MB. Each
background `ui up` and `ui restart` (and each launchd start through them) also starts a new log: it rewrites the
file to one session marker, so the old lines are gone. `ui logs` and `ui attach` show the current session only.

`GENESIS_TOOLS_HOME` replaces the home folder that holds `.genesis-tools`, not the `.genesis-tools` folder itself.
With `GENESIS_TOOLS_HOME=/x`, every `~/.genesis-tools/...` path above moves to `/x/.genesis-tools/...`.

## Configuration

`~/.genesis-tools/dev-dashboard/config.json` (mode 0600, because it holds the password hash). Keys and defaults:

| Key | Default | Meaning |
|---|---|---|
| `port` | `3042` | Public port of the front proxy |
| `allowedHosts` | `[]` | Hostnames Vite accepts; the first one is the public URL |
| `obsidianVault` | resolved | Vault root override |
| `auth.enabled` | `true` | Require Basic Auth |
| `auth.username` | see `auth reset --help` | Basic Auth user |
| `cmuxPollIntervalMs` | `2000` | Server cmux refresh (min 250) |
| `pulse.retentionHours` | `24` | Pulse history kept |
| `pulse.pollIntervalMs` | `5000` | Pulse sample interval (min 1000) |
| `weatherCoords` | Prague | `latitude`, `longitude`, `label` |
| `todoListName` | `GenesisTools` | Reminders list for hub memo todos |

`publishedNotes` and `ttydSessions` are state the dashboard writes; do not edit them by hand. Host-specific values
(domain, allowed email, tunnel name) live in this file or in Cloudflare, not in this repo.

A config file that does not parse or fails the schema is never overwritten: the dashboard serves defaults, logs a
warning, and refuses every save until you fix or move the file.

Launcher preferences in `~/.genesis-tools/dashboards/dev-dashboard.config.json`: `bindHost` (`"0.0.0.0"` or
`"127.0.0.1"`), `launchdServe` (`"preview"` after `install --preview`), `launchdInstalled`, `launchdPromptDismissed`.

Environment variables:

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_HOME` | Home that holds `.genesis-tools` (default: your home) |
| `BOARDS_DB_PATH` | Boards database path |
| `BOARDS_LISTENER_TTL_MS` | Board listener lease TTL |
| `DASHBOARD_BIND_HOST` | Listen address the launcher passes |
| `DD_DISK_DU_TIMEOUT_MS` | `du` timeout for the disk page (default 4000) |
| `DD_QA_BASE_URL` | Base URL for the Playwright tests |
| `PROFILE=ttyd,tmux` | Profile the ttyd and tmux paths |

## For agents

- Start and stop through the `ui` verbs, never with a raw `vite` or `bun` process. `ui status` reports the state.
- `configure` and `tunnel setup` need a TTY. Without one they print the command to run and exit 1.
- `ui open` prints the URL on stderr, not stdout. It exits 1 when the dashboard is not running and there is no TTY,
  and when the page does not answer within 10 s. With `--no-open` it prints the URL and does not wait.
- `share` prints only the URL on stdout and `published <path>` on stderr, so `url=$(tools dev-dashboard share X)`
  works. It exits 1 with the error on failure.
- The question and decision forms of `tools question` land on `/qa`. The genesis-tools MCP `question_*` tools write
  there too.
- No `--json` output and no MCP tools of its own. Read state through the HTTP API instead.
- Before you paste a `http://localhost:3042/...` link, check what a click does: see the browser-router skill.

## Troubleshooting

- **Public "Bad Gateway" on the tunnel host.** The front proxy returned a 502. Read the `front proxy: returning 502`
  lines in `tools dev-dashboard ui logs`. `reason` names the cause: `upstream-timeout`, `upstream-refused`,
  `retries-exhausted`, `upstream-error`, `ttyd-missing` or `client-abort`. `previewRestarting` says whether the
  preview server was swapping at the time. `upstream-refused` (the startup race) and `client-abort` (a closed tab)
  log at debug level only, so the normal background log does not show them.
- **Vite blocks a request from a new hostname.** Vite rejects hostnames that are not registered when it serves on
  `0.0.0.0`. Add the host with `tools dev-dashboard configure`.
- **Code changes do not show up.** Static mode serves one build. Run `ui restart`, or use `ui dev` or
  `ui install --preview`.
- **Saves fail with "fails schema validation, so it was left untouched".** The config file is broken. Fix or move
  `~/.genesis-tools/dev-dashboard/config.json`; the dashboard never writes over it.
- **Login asks for a password you never set.** Look for "generated dev-dashboard basic auth password" in
  `ui logs`. The line stays only until the next `ui up` or `ui restart`, which starts a new log. After that, run
  `auth reset`.
- **`ui open` asks for a password, but `localhost` did not.** `ui open` opens the LAN address, which is not a
  localhost request. Open `http://localhost:3042` instead.
- **`ui up -p <n>` reports a failed readiness check.** The server listens on `port` from `config.json`, not on `-p`.
  Set `port` there and pass the same `-p`.
- **Terminals page is empty or a spawn fails.** ttyd is expected at `/opt/homebrew/bin/ttyd`. Install it with
  Homebrew.
- **Todos page shows a permission error.** Grant Reminders access; `tools macos permissions` shows the grant state.

## Related

- [question](../question/README.md): the Q&A and decision log shown on `/qa`.
- [hub](../hub/README.md): the capabilities behind `/api/gateway/*`.
- [daemon](../daemon/README.md): the tasks and runs on `/daemon` and `/build-log-tail`.
- [cmux](../cmux/README.md): the sessions on `/cmux`.
- [telegram-bot](../telegram-bot/README.md): shares the tunnel host for its webhook.
- [browser-router](../browser-router/README.md): opens dashboard links and starts the dashboard on a click.
- [macos](../macos/README.md): permission checks for Reminders.

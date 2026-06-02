# Current dev-dashboard architecture (baseline map)

> Reference for the mobile-clone + commercial-product plans. Captures the **existing**
> `src/dev-dashboard/` system as of `feat/dev-dashboard-mobile` @ `90196aecd`.
> Everything below is verified against the source, not assumed.

## TL;DR

- **Backend is a Vite dev/preview server with a Connect middleware** (`ui/vite-middleware.ts`)
  that exposes ~38 JSON `/api/*` routes + **one SSE stream** (`/api/qa/stream`) + a public
  `/share/<slug>` HTML route.
- **Every route handler is a thin controller** that delegates to `lib/<feature>/*` business
  logic. The HTTP/transport layer is the only thing coupled to Vite + Node `http` types.
  → Extracting a standalone server = lift routing into a transport-agnostic handler registry;
  `lib/*` move untouched.
- **Terminals (ttyd) are NOT served via `/api`.** `ttyd` runs its own per-session server;
  the web UI embeds it as an `<iframe>` over WebSocket, proxied by `lib/front-proxy.ts`.
  The mobile terminal must reach that same WS through whatever transport we pick.
- **Frontend** = React + TanStack Router + TanStack Query, Vite-bundled. 9 feature routes.

## Process / serve model

- `index.ts` (`tools dev-dashboard`) spawns Vite (`dev` or `build --watch` + `preview`) on an
  internal loopback port, then puts a **front-proxy** (`lib/front-proxy.ts`) on the public port
  (`:3042` default; configurable). The front proxy:
  - binds `0.0.0.0` (LAN-reachable) and is what a Cloudflare Tunnel points at;
  - sets the `x-dd-local-origin: 1` header **only** for genuine loopback hits (and strips any
    inbound forgery) — this is the loopback auth exemption;
  - special-cases long-lived streams: `isLongLivedProxiedStream("/api/qa/stream") === true`.
- Config: `~/.genesis-tools/dev-dashboard/config.json` (`config.ts`). Holds port, auth
  (basic-auth username + password hash + enabled), pulse retention/poll, cmux poll interval,
  weather coords, obsidian vault path, published-notes registry, host/tunnel identity.
- Two background pollers boot on module load: **cmux poller** (`lib/cmux/poller.ts`,
  `startPolling`) and **pulse poller** (`lib/system/poller.ts`, `startPulsePolling`) — both
  cache snapshots in-memory and serve them to the GET endpoints.

## Auth model (`lib/auth.ts` + `requireDashboardAuth`)

Order of checks per request:
1. `GET /share/<slug>` (exact single-segment) → **bypass** (slug is a 96-bit token credential).
2. `x-dd-local-origin: 1` header present → **bypass** (loopback only; cannot be forged remotely).
3. If `auth.enabled === false` → allow.
4. Valid **session cookie** (`verifySessionToken`) → allow.
5. Valid **Basic Auth** header (`verifyBasicAuthHeader`) → allow **and mint a session cookie**
   (`Set-Cookie`), because browser-initiated **WebSocket** handshakes (ttyd, Vite HMR) cannot
   send an `Authorization` header — they authenticate via the cookie, gated at the front-proxy.
6. Else `401` with `WWW-Authenticate: Basic`.

**Implication for the mobile client:** native HTTP can send `Authorization: Basic …` directly,
but the **ttyd WebSocket** needs the **session cookie** (or a token in the URL) — the mobile
terminal transport must carry the cookie, exactly like the browser does. Carry this into the
transport-abstraction + terminal plans.

## Full `/api` contract (consume verbatim in the shared contract package)

### tmux
- `GET  /api/tmux/sessions` → `{ sessions: TmuxHubSession[] }`
- `POST /api/tmux/create` `{ name?, cwd?, command? }` → `{ sessionName, cwd, command }`
- `POST /api/tmux/rename` `{ from, to }` → `{ sessionName }`

### ttyd
- `GET  /api/ttyd/list` → `{ sessions: TtydSession[] }`
- `POST /api/ttyd/spawn` `{ command?, cwd?, tmuxSessionName? }` → `{ session }` (409 if conflict)
- `POST /api/ttyd/kill` `{ id, killTmux? }` → `{ ok }`
- `POST /api/ttyd/rename` `{ id, name }` → `{ ok }`

### cmux
- `GET  /api/cmux/snapshot` → `{ snapshot: CmuxSnapshot }`
- `GET  /api/cmux/layout` → `{ layout: CmuxLayoutTree }`
- `POST /api/cmux/create-terminal` `{ cwd? }` → `{ result: AttachTmuxResult }`
- `POST /api/cmux/create-workspace` `{ windowId, name?, cwd? }` → `{ result }`
- `POST /api/cmux/send-session` `{ tmuxSessionName, target, cwd? }` → `{ result }`
- `POST /api/cmux/remove-session` `{ tmuxSessionName }` → `{ removed }`
- `POST /api/cmux/attach` `{ workspaceId, paneId }` → `{ ok }`
- `POST /api/cmux/rename` `{ workspaceId, surfaceId?, title }` → `{ ok }`

### system / pulse (the "Pulse" feature)
- `GET  /api/system/pulse` → `PulseSnapshot` (cpuPct, mem*, swap*, battery*, disk*, wifiSsid,
  topProcesses[], capturedAt) — or `{ capturedAt: null }` if not yet polled.
- `GET  /api/system/pulse/history?metric=<cpu|…>&minutes=<n>` → `PulseSeries` (`points[]`).

### weather
- `GET  /api/weather` → weather payload for configured coords.

### claude usage
- `GET  /api/claude/usage` → current usage.
- `GET  /api/claude/usage/history?account=&buckets=a,b&bucket=five_hour&minutes=1440`.

### daemon
- `GET  /api/daemon/status` → overview.
- `GET  /api/daemon/runs?task=&limit=20`.
- `GET  /api/daemon/runs/log?logFile=…`.

### containers
- `GET  /api/containers` → docker container list.

### qa (the live Q&A feature — has the SSE stream)
- `GET  /api/qa/log?project=&tag=&unread=1&limit=100` → `{ entries }`.
- `POST /api/qa/read` `{ ids[], unread? }` → `{ ok, updated }`.
- `GET  /api/qa/audio-library` → `{ bundled[], synth[] }`.
- `GET  /api/qa/sound?id=` → `audio/wav` bytes.
- `POST /api/qa/config` `{ sound?, soundVolume? }` (shells out to `tools question config`).
- **`GET  /api/qa/stream`** → **SSE** `text/event-stream`; emits `data: <enrichedQaEntry>` per
  new entry, `: ping` keep-alive every 12 s. This is the one long-lived stream.
- `POST /api/qa/save-to-obsidian` `{ entryId, relativeDir, baseName, mode?, … }`.

### todos (macOS Reminders-backed)
- `GET    /api/todos?listIds=a,b&includeCompleted=true` (503 if Reminders permission denied).
- `POST   /api/todos/request-access`.
- `POST   /api/todos` `{ title, listName?, due?, priority?, notes? }`.
- `POST   /api/todos/complete` `{ reminderId }`.
- `PATCH  /api/todos` `{ reminderId, listIdentifier, title, notes?, due?, priority?, url? }`.
- `DELETE /api/todos` `{ reminderId }`.

### obsidian
- `GET  /api/obsidian/tree` → `{ entries: VaultEntry[] }`.
- `POST /api/obsidian/mkdir` `{ relativeDir }`.
- `GET  /api/obsidian/note?path=` → `{ source, html, publishedSlug }`.
- `POST /api/obsidian/publish` `{ path }` → `{ note }`.
- `POST /api/obsidian/unpublish` `{ slug }` → `{ remaining }`.

### public
- `GET /share/<slug>` → rendered HTML note page (no auth; token-gated).

## Frontend surface (`ui/src/`)

- **Routing**: TanStack Router (`routes/__root.tsx` + 9 routes: `index` (home/Pulse), `claude`,
  `cmux`, `containers`, `daemon`, `obsidian`, `qa`, `todos`, `ttyd`).
- **Data**: TanStack Query; client wrappers in `lib/api.ts` (typed `ttydApi/tmuxApi/cmuxApi/
  obsidianApi`; other features fetch inline). `lib/query-keys.ts`, `lib/nav-routes.ts`.
- **Pulse UI**: `components/pulse/` — `KpiCard`, `PulseGraph`, `NetworkInfo`, `ProcessTable`,
  `WeatherCard`.
- **Terminal UI**: `components/TtydFrame.tsx` (iframe), `TtydPane`, `TtydScrollPads`,
  `MobileKeyBar`, `TtydPasteDialog`, `terminal-shell/MobileTerminalShell`. Mobile affordances
  ALREADY exist here (key bar, scroll pads, paste) — port these concepts to native.
- **cmux UI**: `CmuxLayoutTree`, `CmuxSessionList`, `CmuxSendTargetDialog`, `TmuxSessionsPanel`.
- **qa UI**: `Qa*` components + `LiveSseIndicator` (SSE connection state).
- Hooks: `useLayoutMode`, `useMediaQuery`, `useVisualViewportSize`, `useLockPageScroll` — these
  encode the responsive/mobile behavior we must reproduce natively.

## System telemetry collector (`lib/system/collector.ts`)

`collectPulse()` runs macOS shell tools concurrently:
- CPU: `top -l 1 -n 0` → 100 − idle%.
- Mem: `vm_stat` + `sysctl hw.pagesize hw.memsize` + `memory_pressure` (free %).
- Swap: `sysctl vm.swapusage`. Battery: `pmset -g batt`. Disk: `df -k /`.
- Wi-Fi SSID: `networksetup`. Top 5 processes by RSS: `ps -axo …`.
- `history-db.ts` persists series to SQLite for `/pulse/history`.

→ This is **macOS-specific**. A cross-platform / Linux agent (commercial customers) needs a
**platform-abstracted collector** — note for the server-extraction + product plans.

## Extraction seams (for "extract backend service")

1. **Handler registry**: replace the `if (method && path)` chain with a declarative table of
   `{ method, path, handler(ctx): Response }` using Web `Request`/`Response`, plus a tiny adapter
   for Node `IncomingMessage`/`ServerResponse` (Vite today) and a native `Bun.serve` adapter
   (standalone agent). SSE + binary (`audio/wav`) need streaming-capable response support.
2. **Auth as middleware**: `requireDashboardAuth` becomes transport-agnostic auth that the
   registry runs first; token/cookie/basic stays identical.
3. **Pollers**: `startPolling`/`startPulsePolling` already module-scoped; move into an explicit
   `start()` lifecycle the standalone server owns.
4. **Platform collector**: factor `collector.ts` behind a `SystemCollector` interface (macOS impl
   today; Linux/Windows impls for the product).
5. **ttyd/cmux/tmux** are macOS-dev-centric; for the product they become **capability plugins**
   the agent advertises (a customer Linux box may have tmux but not cmux).

## Open questions deferred to research (workflow `dd-mobile-terminal-research`)

- Terminal rendering on RN/Expo SDK 55 (WebView-ttyd vs native vs xterm-via-DOM). → files 01-03 + 06.
- SSE consumption on RN 0.83 New Arch; WebSocket reliability. → file 04.
- Trust/transport tiers (LAN / Cloudflare Tunnel / Tailscale / managed) + the "we can't see your
  data" claim vs a vendor-managed tunnel. → file 04.
- Charting lib for live Pulse metrics + Expo SDK 55 foundation stack. → file 05.

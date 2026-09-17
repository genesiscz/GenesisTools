# dev-dashboard

Personal web dashboard for terminals (ttyd), cmux session viewing, and Obsidian note sharing. Runs at `http://localhost:3042`; optionally exposed at `https://<your-host>` via a Cloudflare Tunnel.

## Run

```bash
tools dev-dashboard ui up          # build once, then serve (default; what `ui install` registers)
tools dev-dashboard ui restart
tools dev-dashboard ui up --foreground
tools dev-dashboard ui dev         # Vite dev + HMR in the foreground; Ctrl+C brings the installed server back
tools dev-dashboard ui install     # launchd agent on the built bundle
tools dev-dashboard ui install --preview   # launchd agent on the watch build (rebuild on save, page reload); kept until the next install
```

Default serve mode is **static** (one Vite build into `~/.genesis-tools/dashboards/dev-dashboard.static/`, then `vite preview` behind the front proxy): a few bundled assets per load, much faster over the Cloudflare tunnel than per-module dev requests, and nothing watches anything while the server idles. Restart the server to pick up code changes.

To work on the dashboard, run `ui dev`: it stops the installed server (launchd agent or background instance), runs Vite dev + HMR in the foreground, and starts the installed server again when you stop it. To keep the watch mode running under launchd instead (`build --watch` + preview: rebuild and page reload on save, bundled assets over the tunnel), run `ui install --preview`; a later `ui up` or `ui restart` keeps whichever mode the last `install` chose.

APIs (`/api/tmux/*`, Obsidian share, ttyd) behave the same in every mode. Harness config lives in `ui/app.ts` (`buildDashboardUiServerCmd` from `@genesiscz/utils/DashboardApp`). The serve loop itself is `runDashboardPreviewUiServer` in `@genesiscz/utils/DashboardApp/preview`; dev-dashboard only wires front-proxy, Reminders paths, and reload hooks in `lib/preview-ui-server.ts`.

**Listen address:** dev-dashboard is the one dashboard bound to `0.0.0.0` by default (tunnel, phones). `{ "bindHost": "127.0.0.1" }` in `~/.genesis-tools/dashboards/dev-dashboard.config.json` pins it to loopback; the same key opens any other dashboard to the LAN.

Config is stored at `~/.genesis-tools/dev-dashboard/config.json`.

## Boards

Screenshot annotation boards (`tools boards` CLI + `boards_*` MCP tools — see
`src/boards/README.md` for the CLI/listening workflow). Routes live under `/api/boards/*`
(static-prefix routes like `/api/boards/sets/*` and `/api/boards/work/*` are registered
before the `/api/boards/:slug` catch-all, since the router is first-match). Storage:
`<GENESIS_TOOLS_HOME>/dev-dashboard/boards.db` (override with `BOARDS_DB_PATH`) plus a
content-addressed blob store at `<...>/dev-dashboard/boards/blobs/<sha256[:2]>/<sha256>.<ext>`.
Live updates go out over `GET /api/boards/:slug/events` (SSE). Annotations follow a
`staged → open → working → in_review → resolved` status machine (plus `cancelled`); a new
annotation is `staged` by default (invisible to the work queue) until a `dispatch` call flips
it to `open`, so a human can review/edit the prompt before it goes live to an agent.

The AI expression layer (`compose`/`arrange`/`update-cards`/`scrape`/`sections`/`questions` —
20 `boards_*` MCP tools total) lets an agent PRESENT on a board, not just answer: batched
markdown/viz/section/question cards placed in one call, server-side auto-layout, a
structured board-digest read, and staged multiple-choice questions that release onto the
work wire on the same `dispatch` gate as annotations. AI-authored cards carry
`payload.layer === "ai"` (no schema column); journey sections are `kind:"section"` cards
with spatial (not FK) membership. Question rows live in `board_questions`
(`board_id, card_id, prompt, options, answer, staged, delivered, multi`) — `delivered` gives
the work-wire's exactly-once drain. See `src/boards/README.md` for the CLI-facing summary and
`src/dev-dashboard/server/static/boards-templates.md` for compose-ready skeletons.

## Public surface

When tunneled (host, allowed identities, and tunnel name are read from local config, not committed here):

- `https://<your-host>/` -> Cloudflare Access gate (email OTP for the configured identity).
- `https://<your-host>/telegram-webhook` -> bypass (secret-token auth).
- `https://<your-host>/share/<slug>` -> bypass (the slug is a cryptographically-random 96-bit token and is the only credential; `unpublish` revokes it).

Publish the same way the Obsidian reader **publish** / **copy** buttons do:

```bash
tools dev-dashboard share "Widgets/Design/2026-08-20-UnconnectedComponents.md"
# prints https://<your-host>/share/<slug> and copies it
tools dev-dashboard share /absolute/path/in/vault/Note.md --no-clipboard
```

Host-specific values (domain, allowed email, tunnel name) live in `~/.genesis-tools/dev-dashboard/config.json`, not in this repo.

## Front-proxy upstream timeouts

Cloudflare turns any front-proxy 502 into a public "Bad Gateway", so the deadline the proxy
puts on an upstream fetch is a user-visible setting. `upstreamTimeoutMs()` in
`lib/front-proxy.ts` gives three tiers:

| Tier | Deadline | Paths |
|---|---|---|
| stream | none | `isLongLivedProxiedStream()` — `/api/qa/stream`, `/api/live`, `/api/boards/work/wait`, `/api/ports/classify`, `/api/boards/*/events` |
| slow | 60s | `/api/ports`, `/api/system/pulse`, `/api/system/pulse/history`, `/api/tmux/sessions` |
| default | 15s | everything else |

The slow tier is measured, not guessed. Every `TimeoutError` in
`~/.genesis-tools/logs/dev-dashboard.bg.log` up to 2026-08-31 12:30 was one of those four
paths: `/api/ports` 36, `/api/system/pulse/history` 18, `/api/system/pulse` 4,
`/api/tmux/sessions` 1. Each one was a 502 on the public hostname. They stay bounded rather
than joining the stream tier, because none of them streams and an unbounded fetch holds the
proxy connection open forever when the upstream wedges.

The other 23193 warnings in that log were `AbortError` on `/api/live` and `/api/qa/stream` —
a browser closing an SSE tab, not a gateway fault. `classifyUpstreamFailure()` now separates
the two, and every 502 the proxy returns logs one `front proxy: returning 502` line carrying
`reason`, `httpTarget`, `attempts`, `timeoutMs`, `errName`, `errCode` and `previewRestarting`.

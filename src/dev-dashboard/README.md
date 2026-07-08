# dev-dashboard

Personal web dashboard for terminals (ttyd), cmux session viewing, and Obsidian note sharing. Runs at `http://localhost:3042`; optionally exposed at `https://<your-host>` via a Cloudflare Tunnel.

## Run

```bash
tools dev-dashboard ui up          # watch build + preview (default)
tools dev-dashboard ui restart
tools dev-dashboard ui up --foreground
```

Default serve mode is **preview** (Vite `build --watch` + `vite preview`): a few bundled assets per load, much faster over the Cloudflare tunnel than per-module dev requests. Saves trigger a rebuild (~1s) and a full page reload (not HMR).

For Vite dev + HMR on localhost only:

```bash
tools dev-dashboard ui up --dev --foreground
```

APIs (`/api/tmux/*`, Obsidian share, ttyd) behave the same in both modes. Harness config lives in `ui/app.ts` (`buildDashboardUiServerCmd` from `@app/utils/DashboardApp`). The preview loop itself is `runDashboardPreviewUiServer` in `@app/utils/DashboardApp/preview`; dev-dashboard only wires front-proxy, Reminders paths, and reload hooks in `lib/preview-ui-server.ts`.

**Preview mode hot reload:** saves under `ui/src/` rebuild the client bundle (browser reload). Edits to `ui/vite-middleware.ts`, `lib/`, etc. restart the Vite preview subprocess automatically (~1s) — no full `ui restart` needed. Use `ui up --dev` only if you want Vite dev + HMR for the React app.

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

Host-specific values (domain, allowed email, tunnel name) live in `~/.genesis-tools/dev-dashboard/config.json`, not in this repo.

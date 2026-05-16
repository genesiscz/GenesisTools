# dev-dashboard — Design

**Date:** 2026-05-15
**Branch:** `feat/dev-dashboard`
**Status:** v1 spec (deliberately minimal)

## Goal

A single web app served at `http://localhost:3042` and (through the existing `foltyn-home` Cloudflare Tunnel) at `https://mac.foltyn.dev`, giving the user a "modern hackerish" personal dashboard with three panels:

1. **ttyd** — spawn and manage interactive web terminals, arrange in **tabs and split panes**.
2. **cmux** — see the live state of cmux sessions; best-effort attach experiment.
3. **obsidian** — browse the GenesisBrain vault, read notes, **publish notes as shareable links**.

Exposed publicly through the existing tunnel under a single hostname (`mac.foltyn.dev`), gated by **Cloudflare Access** (email OTP for `martin@foltyn.dev`), with deliberate bypass paths for `/telegram-webhook` (existing OpenClaw webhook) and `/share/*` (public note shares).

## Non-goals (out of scope for v1)

- ttyd session persistence across dashboard restarts (in-memory registry only).
- Multi-panel-at-once view in the shell — one panel at a time, switched via sidebar.
- Full Obsidian markdown fidelity — no callouts/embeds/dataview rendering in v1; basic markdown + best-effort wikilinks only.
- cmux interaction beyond viewing + the attach spike.
- GitHub webhook listener, Claude-session web view — these were discussed and intentionally deferred to follow-up specs.
- Authentication beyond Cloudflare Access (no app-level user accounts).

## Architecture

### Tool layout — follows the `clarity` pattern + `claude-history-dashboard` stack

```
src/dev-dashboard/
  index.ts                    # Commander entry; `tools dev-dashboard` launches the UI
  config.ts                   # Zod schema + Storage("dev-dashboard")
  README.md
  commands/
    publish.ts                # Optional CLI: list/manage published notes
  lib/
    ttyd/
      manager.ts              # spawn / list / kill ttyd children; in-memory registry
      types.ts                # TtydSession, SplitLayout
    cmux/
      client.ts               # thin wrapper over src/cmux/lib/socket.ts (re-uses, no fork)
      poller.ts               # interval-driven snapshot fetcher
      types.ts                # CmuxSnapshot, Pane, Surface
    obsidian/
      reader.ts               # vault tree + file read
      markdown.ts             # markdown -> HTML (marked + minimal wikilink rewrite)
      publish.ts              # slug generation, publish registry mutations
      types.ts                # PublishedNote, VaultEntry
  ui/                         # Vite + TanStack Start app on :3042 (mirrors clarity/ui)
    index.html
    vite.config.ts
    tsconfig.json
    biome.json
    package.json
    src/
      main.tsx
      router.tsx
      routes/
        __root.tsx            # Shell: sidebar + main panel
        index.tsx             # Default panel (ttyd)
        ttyd.tsx
        cmux.tsx
        obsidian.tsx
        share.$slug.tsx       # Public share renderer
      components/
        Sidebar.tsx
        TtydPane.tsx          # Recursive split layout node
        CmuxSessionList.tsx
        ObsidianTree.tsx
        ObsidianReader.tsx
      lib/
        api.ts                # Server-function callers
      styles/
        slate-grid.css        # Theme variables + grid background
```

The `index.ts` Commander entry mirrors `src/clarity/index.ts`: a default `ui` action that spawns Vite from `node_modules/vite/bin/vite.js` pointed at `src/dev-dashboard/ui/vite.config.ts`, then opens `http://localhost:3042`.

### Persistent config (`~/.genesis-tools/dev-dashboard/config.json`)

```ts
{
  port: 3042,                                         // listen port
  obsidianVault: "/Users/Martin/Tresors/Projects/GenesisBrain",
  publishedNotes: [
    { slug: string, vaultPath: string, publishedAt: string }
  ],
  cmuxPollIntervalMs: 2000,                            // can be tuned
}
```

Schema validated with Zod, persisted via `Storage("dev-dashboard")` from `@app/utils/storage/storage`, chmod 600 on POSIX. Pattern matches `src/clarity/config.ts`.

### Stack

- **Runtime:** Bun (same as the rest of GenesisTools).
- **Frontend:** TanStack Start + React 19 + TanStack Router + TanStack Query + Vite + Tailwind + shadcn (consumed from `src/utils/ui/`).
- **Server functions:** TanStack Start server functions in the same process — no separate backend.
- **No build step required to run** — Vite dev server during normal operation; `bun run build` available for production-mode serving.

## Visual design — "Slate Grid"

Locked theme:

| Token | Value |
|---|---|
| Base background | `#0c0e10` (near-black slate) |
| Panel background | `#101316` |
| Panel border | `#1e2428` (crisp, thin) |
| Grid lines | `rgba(52,211,153,0.04)` on a `20px` grid |
| Accent gradient | `linear-gradient(135deg, #34d399, #2dd4bf)` (emerald → teal) |
| Text — primary | `#e6edf3` |
| Text — secondary | `#8b96a0` |
| Text — muted | `#5b6670` |
| Font — UI | system sans (Tailwind default) |
| Font — code/headers | `ui-monospace, SFMono-Regular, Menlo, monospace` |

Shell: left icon sidebar (~62px) + main panel area. Sidebar shows one icon per panel (ttyd, cmux, obsidian), active icon styled with the accent gradient. Logo uses the accent gradient with a subtle glow. Progress bars and active-session dots use the accent gradient. Grid background visible across the whole shell, tied to panel padding for a "graph-paper terminal" feel.

Frontend implementation must follow GenesisTools UI feedback memory: **all generic UI uses shadcn components from `src/utils/ui/`** — no custom markup for things like buttons, dialogs, tabs. The implementation phase will invoke the `frontend-design` skill before writing UI code.

## Panels

### 1. ttyd

**Responsibility:** spawn and manage interactive web terminals; arrange them in tabs and split panes.

**Server side (`lib/ttyd/manager.ts`):**

- `spawnTtyd({ command?, cwd? })` → spawns `ttyd -W -p <freePort> <command|zsh>` as a child process, allocates a free port via `src/port/lib` helpers, registers `{ id, port, command, cwd, startedAt, pid }` in an in-memory `Map`. Returns the session.
- `listTtyd()` → all registered sessions.
- `killTtyd(id)` → SIGTERM the child; remove from registry.
- On dashboard shutdown, all spawned ttyd children are killed.
- **In-memory only** for v1 — no persistence across restarts.

**Frontend (`components/TtydPane.tsx`):**

- Layout is a **recursive split tree** — each node is either:
  - A leaf: a single ttyd iframe (`<iframe src={`http://localhost:${session.port}`} />`)
  - A split: `{ direction: "horizontal" | "vertical", children: [Node, Node], ratio }`
- Reuses `react-mosaic-component` (or equivalent mature lib) — do not roll our own splitter.
- Tab strip at top of the ttyd route lets the user maintain multiple split-tree layouts side-by-side ("workspaces"); the active workspace's tree is rendered.
- Toolbar actions: New terminal · New split (H/V) · Close pane · Close tab.

**Why this scope:** keeps tabs *and* splits per the user's v1 request, without inventing layout primitives.

### 2. cmux

**Responsibility:** show the live state of cmux sessions and try a best-effort attach.

**Server side (`lib/cmux/client.ts`, `lib/cmux/poller.ts`):**

- Re-uses `src/cmux/lib/socket.ts` (existing JSON-RPC socket client) — does not fork or duplicate.
- A polling loop calls `surface.list`, `pane.list`, and `capture-pane`-equivalent RPCs every `cmuxPollIntervalMs` (default 2000ms) and exposes the latest snapshot via a server function.
- Frontend subscribes via TanStack Query with a 2s `refetchInterval`.

**Frontend (`components/CmuxSessionList.tsx`):**

- Renders workspaces → panes hierarchy, with the latest scrollback preview for the active pane in each.
- Active panes show an emerald accent dot with subtle glow; idle/closed panes show a muted dot.
- Updates live as the poller refreshes.

**Attach spike** *(best-effort, may not land in v1):*

cmux 0.63.2 has no real "attach" RPC. Spike investigates two paths, in order:

1. **`cmux capture-pane --follow`-style streaming** — if any cmux CLI flag/RPC supports a continuous content stream, spawn a ttyd running it for the selected pane, giving a live-tailing view next to the snapshot.
2. **Fallback:** clicking a pane opens a fresh ttyd in a new tab with `cd <pane-cwd>` (if discoverable) — not a true attach, but useful adjacency.

If neither path is viable within v1 build time, ship live-view only and note the limitation. **The spec does not block on the spike succeeding.**

### 3. obsidian

**Responsibility:** browse the GenesisBrain vault, read notes, publish notes as shareable links.

**Server side (`lib/obsidian/reader.ts`, `markdown.ts`, `publish.ts`):**

- `listVault()` → tree of folders/files under `obsidianVault` (excluding `.obsidian/`, `.trash/`, `.git/`, dotfolders).
- `readNote(path)` → file contents.
- `renderNote(path)` → markdown rendered to HTML via `marked`; wikilinks (`[[Note Name]]`) post-processed:
  - If `Note Name` resolves to a vault file AND that file is published, link to its `/share/<slug>`.
  - Else render as plain styled text (no broken link).
- `publishNote(path)` → generates a 16-byte random URL-safe slug, appends `{ slug, vaultPath, publishedAt }` to `config.publishedNotes`.
- `unpublishNote(slug)` → removes the entry.
- `listPublishedNotes()` / `getPublishedNote(slug)` for the public share route.

**Frontend:**

- `components/ObsidianTree.tsx` — vault tree with collapse/expand, search input filters by filename.
- `components/ObsidianReader.tsx` — renders the selected note's HTML. Toolbar has **Publish / Unpublish** + **Copy share link** when published.
- `routes/share.$slug.tsx` — public renderer for published notes, server-side validates slug via `getPublishedNote`, renders standalone (no sidebar/shell), 404 if slug unknown.

**Markdown scope (v1):** basic CommonMark/GFM via `marked` + the wikilink post-process. Out of scope: callouts (`> [!note]`), embeds (`![[...]]`), dataview, frontmatter rendering, mermaid, math. These are non-trivial; defer to a future Obsidian-fidelity spec.

## Cloudflare Tunnel — additive ingress

Existing `~/.cloudflared/config.yml` is **extended**, not replaced. Order matters (first match wins):

```yaml
tunnel: foltyn-home
credentials-file: /Users/Martin/.cloudflared/d60ec566-6ac0-4792-9e9b-f5f0e6dce60b.json

ingress:
  - hostname: mac.foltyn.dev
    path: /telegram-webhook
    service: http://127.0.0.1:8787      # existing — OpenClaw, stays first
  - hostname: mac.foltyn.dev
    service: http://127.0.0.1:3042      # NEW — dev-dashboard catches everything else
  - service: http_status:404
```

No new `cloudflared tunnel route dns` call — `mac.foltyn.dev` already CNAMEs to the tunnel. After editing the config, reload: `cloudflared tunnel ingress validate && launchctl kickstart -k system/com.cloudflare.cloudflared` (after `sudo cloudflared service install` is run).

## Cloudflare Access — gate everything except webhooks and shares

**Manual one-time setup** in the Cloudflare Zero Trust dashboard:

- Create an Access Application:
  - **Type:** Self-hosted
  - **Application name:** `dev-dashboard`
  - **Application domain:** `mac.foltyn.dev` (path `*`)
  - **Identity provider:** Email (One-Time PIN)
  - **Policy:** Allow `martin@foltyn.dev`
- **Bypass paths** (no auth required for these):
  - `/telegram-webhook` — secret-token-authenticated webhook, must not require login.
  - `/share/*` — slug *is* the credential; published note shares must be reachable by anyone with the URL.

Effective protection matrix:

| Path | Gate |
|---|---|
| `/telegram-webhook` | Access bypass → OpenClaw validates `X-Telegram-Bot-Api-Secret-Token` |
| `/share/<slug>` | Access bypass → opaque random slug *is* the credential; unpublish to revoke |
| Everything else (`/`, ttyd iframes, cmux, obsidian browser, server functions) | Cloudflare Access (email OTP for `martin@foltyn.dev`) |

## Data flow

```
Browser (mac.foltyn.dev or localhost:3042)
   │
   ├─ GET /                        → TanStack Start renders shell + active panel
   ├─ GET /ttyd                    → React loads TtydPane; calls listTtyd() server fn
   ├─ POST /api/ttyd/spawn         → spawnTtyd() → ttyd child on free port; iframe src returned
   ├─ GET /cmux                    → loads CmuxSessionList; TanStack Query polls cmux snapshot
   ├─ GET /obsidian                → loads tree + reader; on Publish → publishNote() → config write
   ├─ GET /share/:slug             → public, no Access; renderPublishedNote(slug) → HTML
   │
   └─ (ttyd iframes load directly from http://localhost:<port>, served by ttyd children)
```

Server functions execute in-process — no separate API server. Process state (ttyd registry, cmux poll cache) lives in the dashboard process and resets on restart.

## Error handling

- ttyd spawn failure (port collision, ttyd not on PATH): server function returns structured error; UI shows a toast and skips the tab. Manager logs via `@app/logger`.
- cmux socket unavailable: poller marks snapshot as "cmux not running"; UI shows a clear empty state with a "cmux is not running — start the cmux app" message.
- Obsidian vault path missing: surfaced in `tools dev-dashboard doctor` (optional CLI command) and as a banner in the obsidian panel.
- Publish slug collision: regenerate; collision probability with 16-byte slugs is negligible but handled.
- Tunnel down: out of scope — that's a `cloudflared` / system concern; the dashboard itself doesn't monitor it.

## Testing

- `lib/ttyd/manager.test.ts` — registry add/remove, port allocation, child kill on shutdown (mock `Bun.spawn`).
- `lib/cmux/client.test.ts` — mock socket responses, ensure poller emits snapshots.
- `lib/obsidian/publish.test.ts` — slug generation determinism (when seeded), publish/unpublish round-trip, share lookup.
- `lib/obsidian/markdown.test.ts` — wikilink rewriting (published → link, unpublished → plain), basic markdown render.
- UI components — light coverage; component logic primarily lives in `lib/`.

## Decisions deliberately deferred

| Decision | Resolution path |
|---|---|
| True cmux interactive attach | Spike during build; ship live-view if no clean path. Re-evaluate when cmux gains attach RPC. |
| Obsidian callouts/embeds/dataview | Separate "obsidian-fidelity" spec once v1 ships. |
| Multi-panel-at-once shell view | Separate UX spec; v1 ships single-active-panel. |
| GitHub webhook listener | Its own follow-up spec (originally part of brainstorm; intentionally split out). |
| Claude-session web view | Its own follow-up spec; can embed/extend existing `claude-history-dashboard`. |
| ttyd session persistence | Add after v1 if it proves missed. |

## Implementation order (high-level)

1. Scaffold `src/dev-dashboard/` per the layout above (mirror clarity/chd).
2. Wire shell + slate-grid theme + sidebar + empty panel routes.
3. ttyd manager + UI (tabs first, then splits).
4. cmux poller + UI (live view first).
5. Obsidian reader + UI (read first, then publish + share route).
6. cmux attach spike (timeboxed).
7. Extend `~/.cloudflared/config.yml` + reload; verify both `/telegram-webhook` and dashboard reachable.
8. Configure Cloudflare Access app (manual dashboard step) with bypass paths.
9. End-to-end smoke through `https://mac.foltyn.dev`.

The implementation plan (`.plan.md`) — produced next by the `writing-plans` skill — will break each step into the concrete subtasks and verification checks.

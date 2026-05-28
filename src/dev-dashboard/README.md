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

APIs (`/api/tmux/*`, Obsidian share, ttyd) behave the same in both modes. Harness config lives in `ui/app.ts` (`buildDashboardUiServerCmd` from `@app/utils/DashboardApp`).

Config is stored at `~/.genesis-tools/dev-dashboard/config.json`.

## Public surface

When tunneled (host, allowed identities, and tunnel name are read from local config, not committed here):

- `https://<your-host>/` -> Cloudflare Access gate (email OTP for the configured identity).
- `https://<your-host>/telegram-webhook` -> bypass (secret-token auth).
- `https://<your-host>/share/<slug>` -> bypass (the slug is a cryptographically-random 96-bit token and is the only credential; `unpublish` revokes it).

Host-specific values (domain, allowed email, tunnel name) live in `~/.genesis-tools/dev-dashboard/config.json`, not in this repo.

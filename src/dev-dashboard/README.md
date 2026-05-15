# dev-dashboard

Personal web dashboard for terminals (ttyd), cmux session viewing, and Obsidian note sharing. Runs at `http://localhost:3042`; exposed at `https://mac.foltyn.dev` via the existing Cloudflare Tunnel.

## Run

```bash
tools dev-dashboard
```

Config is stored at `~/.genesis-tools/dev-dashboard/config.json`.

## Public surface

When tunneled via `foltyn-home`:

- `https://mac.foltyn.dev/` -> Cloudflare Access gate (email OTP for `martin@foltyn.dev`).
- `https://mac.foltyn.dev/telegram-webhook` -> bypass (OpenClaw secret-token auth).
- `https://mac.foltyn.dev/share/<slug>` -> bypass (slug is the credential; `unpublish` revokes).

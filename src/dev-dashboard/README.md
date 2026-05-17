# dev-dashboard

Personal web dashboard for terminals (ttyd), cmux session viewing, and Obsidian note sharing. Runs at `http://localhost:3042`; optionally exposed at `https://<your-host>` via a Cloudflare Tunnel.

## Run

```bash
tools dev-dashboard
```

Config is stored at `~/.genesis-tools/dev-dashboard/config.json`.

## Public surface

When tunneled (host, allowed identities, and tunnel name are read from local config, not committed here):

- `https://<your-host>/` -> Cloudflare Access gate (email OTP for the configured identity).
- `https://<your-host>/telegram-webhook` -> bypass (secret-token auth).
- `https://<your-host>/share/<slug>` -> bypass (the slug is a cryptographically-random 96-bit token and is the only credential; `unpublish` revokes it).

Host-specific values (domain, allowed email, tunnel name) live in `~/.genesis-tools/dev-dashboard/config.json`, not in this repo.

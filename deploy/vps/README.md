# VPS deploy — youtube + ai-proxy + eve trio

Runs the three services behind one TLS nginx front so the browser extension can
talk to a hosted stack instead of each user's laptop. Auth model: **per-user
service key** (Bearer), multi-tenancy is a **shared corpus** for the beta, and
all model calls **bill the owner's subscription** via ai-proxy — so keys are the
only thing standing between a user and the owner's spend. Issue them deliberately.

## Topology

```text
                         :443 TLS (nginx)
   extension / clients ─────────────────────────▶  nginx  ──┐
                                                            │  127.0.0.1 loopback
     /ai/*                    ──▶ ai-proxy  :8317  ◀────────┤  (firewall blocks
     /yt/*                    ──▶ youtube    :9876  ◀────────┤   these ports from
     /eve/*                   ──▶ eve        :2000  ◀────────┤   the public net)
     /.well-known/workflow/*  ──▶ eve        :2000  ◀────────┘
```

- **ai-proxy** — OpenAI-compatible; auth is its own `proxyApiKey` (clients send
  `Authorization: Bearer <proxyApiKey>`). Serves `/v1/*`; nginx strips the `/ai`
  prefix.
- **youtube** — the API the extension consumes; auth is `YOUTUBE_SERVICE_KEY`
  (comma-separated, one per user). Serves `/api/v1/*`; nginx strips the `/yt`
  prefix. `/api/v1/healthz` stays open for probes.
- **eve** — the agent (Nitro). Needs **both** `/eve/` **and**
  `/.well-known/workflow/` forwarded or workflow runs stall. Route protection is
  a merge-time follow-up (see below).

## Prerequisites

- A Linux VPS (systemd), a DNS `A`/`AAAA` record → its IP.
- `bun` installed system-wide (`curl -fsSL https://bun.sh/install | bash`; note
  `which bun` and fix the `ExecStart=` paths in the unit files if it isn't
  `/usr/local/bin/bun`).
- `nginx` and `certbot` (`apt install nginx certbot`).
- A dedicated `genesis` service user whose `~/.genesis-tools/` holds the
  ai-proxy config (`ai-proxy/config.json` with a `proxyApiKey`) and the
  subscription tokens (`ai/config.json` with the `anthropic-sub` / `openai-sub`
  accounts). Copy these from your working laptop — they are NOT in the repo.

## Bring-up

```bash
# 1. Service user + repo checkout
sudo useradd --system --create-home --shell /usr/sbin/nologin genesis
sudo mkdir -p /opt/genesis-tools
sudo chown genesis:genesis /opt/genesis-tools
sudo -u genesis git clone <REPO_URL> /opt/genesis-tools
cd /opt/genesis-tools && sudo -u genesis bun install

# 2. eve build (separate branch/checkout: apps/eve on feat/eve-01-foundation)
#    Build it, then place the output at /opt/eve (or edit WorkingDirectory).
#    e.g.  bun run build   →   copy the app dir (with .output/) to /opt/eve

# 3. Owner config — copy your laptop's ~/.genesis-tools to the service user.
sudo -u genesis mkdir -p /home/genesis/.genesis-tools
sudo rsync -a ~/.genesis-tools/ai-proxy /home/genesis/.genesis-tools/
sudo rsync -a ~/.genesis-tools/ai       /home/genesis/.genesis-tools/
sudo chown -R genesis:genesis /home/genesis/.genesis-tools

# 4. Environment file
sudo mkdir -p /etc/genesis-tools
sudo cp deploy/vps/genesis.env.example /etc/genesis-tools/genesis.env
sudo $EDITOR /etc/genesis-tools/genesis.env   # set DOMAIN, YOUTUBE_SERVICE_KEY, EVE_*
sudo chmod 600 /etc/genesis-tools/genesis.env
#    Generate per-user keys:  openssl rand -hex 24

# 5. systemd units
sudo cp deploy/vps/systemd/genesis-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now genesis-ai-proxy genesis-youtube genesis-eve
sudo systemctl status genesis-youtube --no-pager     # expect active (running)

# 6. TLS certificate (webroot; nginx must be serving :80 first — see step 7)
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN"

# 7. nginx
sudo sed "s/__DOMAIN__/$DOMAIN/g" deploy/vps/nginx.conf | sudo tee /etc/nginx/nginx.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx

# 8. Firewall — expose ONLY ssh + http + https; keep the app ports private.
sudo ufw allow 22,80,443/tcp
sudo ufw deny 8317 && sudo ufw deny 9876 && sudo ufw deny 2000
sudo ufw enable
```

> Both ai-proxy and youtube bind loopback (`127.0.0.1`) by default, so nginx is
> the only path to them; the firewall rules are defense in depth. To reach the
> youtube API directly (e.g. LAN testing), set `YOUTUBE_HOST=0.0.0.0` in
> `genesis.env` (or the systemd unit) — and keep the firewall in front.

> Chicken-and-egg on step 6/7: certbot `--webroot` needs nginx answering :80.
> Either bring nginx up with a plain `:80` server first (the config's HTTP block
> already serves `/.well-known/acme-challenge/`), run certbot, then reload; or
> use `certbot --nginx`.

## Verification (from a second machine)

```bash
# Health is open (no key):
curl -sS https://$DOMAIN/yt/api/v1/healthz            # → 200 {"status":...}

# A real route requires the service key:
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://$DOMAIN/yt/api/v1/videos                    # → 401
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <one-of-YOUTUBE_SERVICE_KEY>" \
  https://$DOMAIN/yt/api/v1/videos                    # → 200

# ai-proxy models (needs the proxyApiKey):
curl -sS https://$DOMAIN/ai/v1/models \
  -H "Authorization: Bearer <proxyApiKey>"            # → model list
```

An eve session round-trip over `https://$DOMAIN/eve/...` completes the picture
(eve route protection is now in place — see the eve section below).

## Extension repoint

In the extension popup/options set the **API base URL** to `https://$DOMAIN/yt`
and the **service key** to the user's key. See the C3 changes (host permissions +
`Authorization: Bearer` on fetch/WS). The events WebSocket sends the key as
`?access_token=` because browsers can't set headers on a WS handshake.

## eve route protection (C1-eve)

**Implemented.** eve protects its HTTP routes with a service-key **route-auth
walk** on the channel factory (`apps/eve/agent/channels/eve.ts` →
`serviceKeyAuth()` in `apps/eve/agent/lib/service-key-auth.ts`). This is the
eve-native equivalent of `src/youtube/lib/server/auth.ts` — eve has **no** Nitro
`server/middleware/` slot, so the guard lives in eve's own auth walk (eve docs:
`node_modules/eve/docs/guides/auth-and-route-protection.md`).

- **Env: `EVE_SERVICE_KEY`** — comma-separated, ONE key per user (same shape as
  `YOUTUBE_SERVICE_KEY`). Unset → open (localhost dev unaffected); set → 401 on a
  missing/wrong key, accept on a matching `Authorization: Bearer <key>`.
  Timing-safe compare (SHA-256 both sides). Generate with `openssl rand -hex 24`.
- **Gated:** `POST /eve/v1/session`, `POST /eve/v1/session/:id`,
  `GET /eve/v1/session/:id/stream`.
- **Always open:** `GET /eve/v1/health` (always public in eve) and
  `/.well-known/workflow/*` (not a channel route) — gating either breaks
  workflow execution.
- **Outbound:** when `YOUTUBE_SERVICE_KEY` is set, eve's youtube connection
  presents its **first** key as `Authorization: Bearer <key>` to the youtube API
  (the `/api/v1/openapi.json` spec fetch is an open meta route, so it needs none).

Set `EVE_SERVICE_KEY` in `genesis.env`; `genesis-eve.service` reads it via
`EnvironmentFile=`. Leave it unset ONLY for a fully-private/firewalled box.

Verified with `eve dev --no-ui` on `:2000` — open mode: `POST /eve/v1/session`
→ 202; keys set: no header → 401, `Bearer <key>` → 202, wrong key → 401,
`GET /eve/v1/health` → 200, `GET /.well-known/workflow/` → 404 (never 401).

## ⚠️ Known limitation — service key in the WS handshake URL

Browsers cannot set an `Authorization` header on a WebSocket handshake, so the
extension's `/yt/api/v1/events` connection sends the durable `YOUTUBE_SERVICE_KEY`
as `?access_token=`. nginx is configured to log that route with a redacted format
(no query string) so the key doesn't land in `/var/log/nginx/access.log`, but the
key is still visible in browser devtools network panels and any full-URL logging
you add elsewhere.

**Follow-up (not in this PR):** replace the durable key with a short-lived,
single-use WS ticket — add a Bearer-authenticated `POST /api/v1/ws-ticket` that
mints a ticket, have the extension call it right before connecting, and have the
WS handshake use `?ticket=` instead of `?access_token=`.

## Notes

- This is a template — no VPS is provisioned yet. `nginx.conf` was validated with
  `nginx -t` (adjusted cert/domain paths); the systemd units are Type=simple
  foreground processes and were review-verified (no local systemd on the author's
  macOS).
- Prefer systemd here (native bun from a repo checkout) over Docker: mounting a
  macOS `node_modules` into a Linux container breaks native modules; a Docker
  path would need an in-image `bun install`.

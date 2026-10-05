# Telegram Bot

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Telegram Bot API client for GenesisTools notifications and remote control.**

A companion to `tools telegram`: this one uses the Bot API (cleaner, no MTProto auth) and is aimed at sending notifications and receiving commands — not at tailing your personal chats.

---

## Quick Start

```bash
# Configure bot token + chat ID
tools telegram-bot configure

# Send a one-off message
tools telegram-bot send "Build finished"

# Start the command listener (long-polling)
tools telegram-bot start
```

---

## Commands

| Command | Description |
|---------|-------------|
| `configure` | Store bot token and default chat ID |
| `send <message>` | Send a one-off message to the default chat |
| `start` | Listen for incoming commands by long-polling |
| `start --webhook` | Listen for incoming commands through a webhook (see below) |
| `webhook status` | Show what Telegram reports for the webhook (read-only) |
| `webhook set` | Tell Telegram where to deliver updates (turns polling off) |
| `webhook delete` | Delete the webhook so polling works again |
| `webhook tunnel` | Show or apply the tunnel rule that routes the webhook path to the receiver |

Run each subcommand with `--help` for the full option list.

---

## Two ways to receive updates

A bot either polls or has a webhook. Telegram never allows both.

| Mode | Command | How updates arrive |
|------|---------|--------------------|
| Polling | `start` | The bot asks Telegram (`getUpdates`) in a loop. It removes any webhook first. |
| Webhook | `start --webhook` | Telegram posts each update to your public URL. A small receiver on this Mac takes it. |

Both modes run the same handler pipeline: the chat allowlist, the rate limits, then the commands (`/status`, `/tasks`, `/run`, `/tools`, `/help`). A webhook adds only the receiver in front of it.

### The receiver

`tools telegram-bot start --webhook [--url <public https url>] [--port <n>] [--path <path>] [--delete-on-exit]`

- Listens on `127.0.0.1` only, on the registered port (entry `telegram-webhook` in `src/utils/ui/dashboards.ts`; `webhook status` prints it). Only the tunnel connector on this Mac reaches it.
- `--url` is the public https URL Telegram delivers to. It is stored in the config, so later runs need no flag. No host is built in, because this repo is public.
- `--path` defaults to the path of the URL. The tunnel forwards the path unchanged, so the two must be equal.
- Calls `setWebhook` at start with the URL, the secret token and `allowed_updates: ["message"]`, which is all the handlers read.
- A clean stop (Ctrl+C or SIGTERM) leaves the webhook set. Telegram then queues updates while the bot is down and retries them. `--delete-on-exit` removes it instead.

### Security model

The public route is open to the internet, so the receiver trusts nothing it has not checked. The checks run in this order, and every refusal has an empty body:

1. Wrong path: 404.
2. Header `X-Telegram-Bot-Api-Secret-Token` missing or not equal to the secret: 401. The compare is constant time. This check runs for every method, so a probe learns nothing about the route.
3. Method other than `POST`: 405. Content type other than JSON: 415.
4. Body over 64 KiB: 413.
5. Body that is not JSON with a numeric `update_id`: 400.

A valid update is answered 200 once its body is read and checked, and handled afterwards, one at a time, in the order the bodies finished arriving. Telegram delivers over several connections at once (`max_connections` defaults to 40), so a slow upload can be overtaken by a later update, and the receiver does not put updates back in `update_id` order. A repeated `update_id` (Telegram retries when it saw no 2xx) is handled once. The receiver remembers the last 1024 ids.

Past the receiver the pipeline is the polling one. An update from a chat that is not the configured chat is dropped without a reply, and only its chat id and update id go to the debug log, never its content. The rate limits apply to the configured chat.

**The secret** is 32 random bytes (base64url), created on the first `webhook set` or `start --webhook`. It lives in the encrypted vault at `telegram-bot/webhook-secret`, and the config keeps only a pointer to it. It is never printed, never in a URL, never logged. Rotate it with `webhook set --rotate-secret`, then restart the receiver. A rotation hands the new secret to Telegram first and stores it only after Telegram accepted it, so a refused or failed call leaves the old secret stored and the running webhook working. The bot token is masked in every error message the webhook commands print.

`webhook status`, and `webhook tunnel` without `--apply`, only read. They change nothing.

The optional config key `apiRoot` points `send`, `start` and the `webhook` commands at another Bot API server, such as a self-hosted one. It must be https, or http on a loopback address, because every request to it carries the bot token. Telegram's own server is the default.

---

## Going live

Replace `<your-host>` with the public host your tunnel serves.

```bash
# 1. Point the tunnel's webhook path at the receiver. Prints a diff.
tools telegram-bot webhook tunnel --url https://<your-host>/telegram-webhook

# 2. Apply it: backs up the cloudflared config, writes it, validates it, restarts the tunnel.
tools telegram-bot webhook tunnel --url https://<your-host>/telegram-webhook --apply

# 3. Start the receiver (also calls setWebhook). Keep it running.
tools telegram-bot start --webhook --url https://<your-host>/telegram-webhook

# 4. Check what Telegram reports: the URL, pending updates, the last delivery error.
tools telegram-bot webhook status
```

Step 2 writes the cloudflared config (`~/.cloudflared/config.yml` unless you pass `--config`) after copying it to `~/.genesis-tools/telegram-bot/backups/`. If `cloudflared tunnel ingress validate` rejects the result, the original is put back and the tunnel is not restarted. Only the rule for this host and path changes. The rule is anchored (`^/telegram-webhook$`), because cloudflared reads `path:` as an unanchored regex and `/telegram-webhook` alone would also capture `/api/telegram-webhook-stats`.

To undo step 2, copy the newest file in the backups folder over the config and restart the tunnel: `launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared`.

`webhook set` does step 3's `setWebhook` without running a receiver. Telegram then queues updates until one runs.

## Going back to polling

```bash
# Stop the receiver (Ctrl+C), then either:
tools telegram-bot webhook delete   # remove the webhook, keep it off
tools telegram-bot start            # polling removes the webhook itself
```

Updates that queued while the receiver was down are delivered to polling. Nothing is lost.

---

## Related

- `tools telegram` — user-account MTProto client
- `tools notify` — multi-channel notification dispatcher that can fan out to Telegram alongside macOS banners, webhooks, and TTS

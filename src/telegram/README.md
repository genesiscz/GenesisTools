# Telegram

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Telegram MTProto user client — listen for messages, browse contacts/history, and auto-respond.**

Unlike `telegram-bot` (which uses the Bot API), this runs as your *user* account via MTProto. Useful for mirroring messages into AI workflows, tailing chats, or answering with a local agent.

---

## Quick Start

```bash
# One-time auth (api_id, api_hash, phone/code)
tools telegram configure

# Listen for new messages (prints to stdout)
tools telegram listen

# Run the TUI watcher with chat list + live messages
tools telegram watch

# Browse contacts
tools telegram contacts

# Browse / search chat history
tools telegram history --chat @someone --limit 100
```

---

## Commands

| Command | Description |
|---------|-------------|
| `configure` | Set up API ID / hash / phone and sign in |
| `listen` | Stream incoming messages as they arrive |
| `watch` | Ink-based TUI with chat list + live message feed |
| `contacts` | List and search contacts |
| `history` | Query chat history (text search, date range, message type) |

Run each subcommand with `--help` for the full option list.

---

## Auth & Storage

- Uses MTProto under the hood; you need a personal `api_id` + `api_hash` from [my.telegram.org](https://my.telegram.org).
- Session files live under `~/.genesis-tools/telegram/`.
- This acts as your user — messages you send count as sent by you, so be careful when pairing with auto-responders.

---

## Related

- `tools telegram-bot` — Bot API flavor for notifications and remote control
- `tools notify` — multi-channel notification dispatcher (can send to Telegram too)

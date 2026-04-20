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

# Start the command listener
tools telegram-bot start
```

---

## Commands

| Command | Description |
|---------|-------------|
| `configure` | Store bot token and default chat ID |
| `send <message>` | Send a one-off message to the default chat |
| `start` | Start the long-poll listener for incoming commands |

Run each subcommand with `--help` for the full option list.

---

## Related

- `tools telegram` — user-account MTProto client
- `tools notify` — multi-channel notification dispatcher that can fan out to Telegram alongside macOS banners, webhooks, and TTS

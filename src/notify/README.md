# Notify

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Unified notification dispatcher — macOS banner, Telegram, webhook, or TTS, from a single command.**

`notify` is the front-end to the shared `utils/notifications` dispatcher used across GenesisTools. One command fans out to every enabled channel: native macOS banners (via `terminal-notifier`), Telegram bot messages, arbitrary webhooks, and text-to-speech (via `tools say`).

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Multi-channel** | System (macOS), Telegram, Webhook, TTS — enable any combination |
| **DnD bypass** | `--ignore-dnd` to punch through Do Not Disturb |
| **Action hooks** | `--open <url>` or `--execute <cmd>` on click |
| **Grouping** | `-g <id>` deduplicates repeat notifications |
| **Interactive config** | `tools notify config` wizard for every channel |

---

## Quick Start

```bash
# Simple banner
tools notify "Build finished"

# Rich banner with title, subtitle, sound, and click URL
tools notify "Deploy finished" -t "CI" -s "staging" --sound Hero --open https://example.com

# Bypass Do Not Disturb
tools notify "Server is down" --ignore-dnd

# Configure channels (interactive)
tools notify config
```

---

## Options

| Option | Description |
|--------|-------------|
| `[message]` | Notification body (positional) |
| `-t, --title <title>` | Banner title |
| `-s, --subtitle <subtitle>` | Banner subtitle |
| `--sound <sound>` | macOS sound name (`Ping`, `Hero`, `Glass`, ...) |
| `-g, --group <id>` | Group ID for deduplication |
| `--open <url>` | URL to open when the banner is clicked |
| `--execute <cmd>` | Shell command to run when clicked |
| `--app-icon <path>` | Custom icon path or URL |
| `--ignore-dnd` | Send even when Do Not Disturb is active |
| `--no-ignore-dnd` | Override an `ignoreDnD=true` default |

---

## Subcommands

| Command | Description |
|---------|-------------|
| `tools notify config` | Interactive wizard to enable / configure each channel (system, Telegram, webhook, say) |

---

## Channels

| Channel | Config needs | Notes |
|---------|--------------|-------|
| **System (macOS)** | default title, sound, ignoreDnD | Uses `terminal-notifier`, falls back to `osascript` |
| **Telegram** | bot token + chat ID | Sends the message via Bot API |
| **Webhook** | URL | POSTs a JSON payload — great for Slack/Discord relays |
| **TTS (say)** | voice name | Spawns `tools say` to speak the message aloud |

Config lives in the shared notifications store under `~/.genesis-tools/`. Sensitive values (Telegram token) are masked in `Show current config`.

---

## Examples

Chain with other tools:

```bash
# Long running task -> ping when done
some-long-command && tools notify "Done!" -t "Build" --sound Glass

# Alert yourself via Telegram (assuming it's configured)
tools notify "Prod error rate spike" -t "ALERT" --ignore-dnd
```

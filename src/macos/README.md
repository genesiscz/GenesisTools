# macOS

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Umbrella CLI for macOS native frameworks — Mail, Calendar, Reminders, Messages, Voice Memos, Sleep.**

`tools macos` exposes a consistent interface for reading and (where supported) writing to macOS native data stores. It reuses the shared DarwinKit bridge so commands feel fast and scriptable compared to `osascript`.

---

## Subcommands

| Subcommand | What it does |
|------------|--------------|
| `mail` | Search, list, and download messages from Apple Mail |
| `calendar` | List calendars/events, search, add, update, delete events |
| `reminders` | List/add/search/remove reminders across lists |
| `messages` | List, search, and show iMessage / SMS conversations |
| `voice-memos` | List, play, export, transcribe, search Voice Memos |
| `sleep` | Inspect macOS sleep / wake metadata |

---

## Quick Start

```bash
# Mail
tools macos mail search "invoice"
tools macos mail list INBOX --limit 20
tools macos mail download ./out --from "boss@example.com"

# Calendar
tools macos calendar list-calendars
tools macos calendar list Work --from 2026-04-01 --to 2026-04-30
tools macos calendar search "standup"
tools macos calendar add "Dentist" --start "2026-05-02 10:00"

# Reminders
tools macos reminders list-lists
tools macos reminders list Home --include-completed
tools macos reminders add "Buy milk" --list Home --due "tomorrow 18:00"

# Messages
tools macos messages list --limit 50
tools macos messages search "meeting"
tools macos messages show "+420..."

# Voice Memos (also available as `tools voice-memos`)
tools macos voice-memos list
```

Run `tools macos <subcommand> --help` for the full option list of each subcommand.

---

## Permissions

Most commands need Full Disk Access and/or specific Privacy permissions (Contacts, Calendars, Reminders, Messages). If you see "not authorized" errors, the CLI prints step-by-step instructions — the short version is:

1. **System Settings -> Privacy & Security -> Full Disk Access** -> enable your terminal app.
2. Grant the specific framework permission when macOS prompts (Calendars, Reminders, ...).
3. Restart the terminal and re-run.

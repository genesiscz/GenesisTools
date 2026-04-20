# Voice Memos

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **List, play, export, and transcribe macOS Voice Memos from the terminal.**

Reads the Voice Memos SQLite database directly, then offers `play`, `export`, `transcribe`, and `search` subcommands. Interactive mode is available when run with no subcommand.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Direct DB access** | Reads the Voice Memos CoreData store, no AppleScript dance |
| **Fast transcription** | Uses Apple's on-device `tsrp` transcript first, AI fallback second |
| **Play** | Streams a memo through the default audio player |
| **Export** | Copies the underlying `.m4a` to a directory |
| **Search** | Matches against titles and transcript text |

---

## Quick Start

```bash
# List all memos
tools voice-memos list

# Play memo #3
tools voice-memos play 3

# Export memo #3 to ~/Desktop
tools voice-memos export 3 ~/Desktop

# Transcribe one memo
tools voice-memos transcribe 3

# Transcribe everything (slow)
tools voice-memos transcribe --all

# Search
tools voice-memos search "project review"

# Interactive picker
tools voice-memos
```

---

## Commands

| Command | Description |
|---------|-------------|
| `list` | List all voice memos with dates and durations |
| `play <id>` | Play the selected memo |
| `export <id> [dest]` | Copy the `.m4a` to `dest` (default: cwd) |
| `transcribe [id] [--all] [--force]` | Transcribe one memo, or all; `--force` re-runs even if a transcript exists |
| `search <query>` | Search titles and transcripts |

---

## Permissions

Requires Full Disk Access for your terminal (the Voice Memos DB lives under `~/Library/Group Containers/`). If you see permission errors, add the terminal app under **System Settings -> Privacy & Security -> Full Disk Access** and restart it.

# YouTube

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **YouTube transcription and caption utilities.**

Currently a thin umbrella around a `transcribe` subcommand that pulls captions (or falls back to audio transcription) for a given YouTube URL or video ID.

---

## Quick Start

```bash
# Transcribe a video (uses captions if available, otherwise AI transcription)
tools youtube transcribe https://www.youtube.com/watch?v=dQw4w9WgXcQ

# By video ID
tools youtube transcribe dQw4w9WgXcQ
```

---

## Commands

| Command | Description |
|---------|-------------|
| `transcribe <url-or-id>` | Fetch captions or transcribe the audio of a YouTube video |

Run `tools youtube transcribe --help` for the full option list.

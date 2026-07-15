# YouTube

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **YouTube transcription and caption utilities.**

A toolkit for YouTube caption/transcription plus an API server the companion browser extension talks to — locally, or hosted behind TLS with per-user service-key auth. The `transcribe` subcommand pulls captions (or falls back to audio transcription) for a given YouTube URL or video ID.

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
| `server` | Run the API server the browser extension consumes (see hosted deployment below) |

Run `tools youtube transcribe --help` for the full option list.

---

## API Server

`tools youtube server` runs a background HTTP API (channel tracking, video/transcript/summary/QA access, the ingest pipeline, cache management, and config) on port 9876.

```bash
tools youtube server          # start in background
tools youtube server status   # pid, port, uptime
tools youtube server down     # stop
```

The full endpoint list is served as a machine-readable OpenAPI 3.1 document at `GET /api/v1/openapi.json`.

## Comments

The `pipeline` command can fetch a video's comments (via `yt-dlp`, capped at 100 by default) and persist them to the local SQLite DB as an opt-in stage:

```bash
tools youtube pipeline dQw4w9WgXcQ --stages metadata,comments
```

Stored comments are served from `GET /api/v1/videos/:id/comments` on the local server and rendered in the video detail UI's Comments tab, which supports search and caps rendering at 50 threads (with a "Show all" expander for larger result sets).

## Hosted deployment & service-key auth

`tools youtube server` serves the API the browser extension consumes. It runs open on localhost by default; to expose it (e.g. a shared VPS) it supports per-user **service-key auth**:

- **`YOUTUBE_SERVICE_KEY`** — comma-separated list of keys, one per user. When set, every route except the open probes (`/api/v1/healthz`, `/api/v1/version`, `/api/v1/openapi.json`) requires `Authorization: Bearer <key>` (the events WebSocket accepts `?access_token=<key>`, since browsers can't set handshake headers). Unset/empty keeps the server open for localhost dev; a value that parses to zero keys (e.g. `,,,`) fails closed at startup rather than silently opening.
- **`YOUTUBE_HOST`** — bind host, defaults to `127.0.0.1` (loopback). Set to `0.0.0.0` only for direct LAN access, and keep a firewall in front.
- **`YOUTUBE_ALLOW_DEV_TOPUP`** — set to `1` to enable `POST /api/v1/users/topup` (the extension's dev-only "Fill diamonds" button). Unset/`0` in production keeps the endpoint 404, since a free diamond mint has no place on a real deployment. Set it locally or the dev top-up button just 404s.

A complete VPS template — nginx TLS front plus systemd units for the youtube, ai-proxy, and eve services — lives in [`deploy/vps/`](../../deploy/vps/README.md); see its README for bring-up steps.

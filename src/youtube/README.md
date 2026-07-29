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
| `ask [question] [targets...]` | Ask across videos, a channel, or a directory of transcripts |
| `queue <add\|list\|show\|watch\|cancel\|stats>` | Enqueue and inspect pipeline jobs |
| `transcripts <export\|import\|show>` | Move transcripts between the database and files |
| `config <get\|set>` | Read and write tool configuration |
| `mcp` | Serve the curated MCP tool set over stdio |
| `server` | Run the API server the browser extension consumes (see hosted deployment below) |

Run `tools youtube <command> --help` for the full option list of any of them.

### Asking questions

`ask` takes one of three corpus selectors, which are mutually exclusive:

```bash
tools youtube ask "what did they say about pricing?" dQw4w9WgXcQ   # explicit video ids
tools youtube ask "what shipped this month?" --channel @bridgemindai
tools youtube ask "summarise the objections" --dir ./exported-transcripts
```

`--session <name>` keeps conversational memory under that name, so follow-up questions
see the earlier turns. `--history --session <name>` prints those turns and exits (no
question argument needed).

A channel ask lazily embeds at most a handful of not-yet-indexed videos per call and
reports the rest as skipped, so a first question against a large channel answers
promptly instead of embedding the whole corpus. Pass explicit ids to `analyze --ask`
when you want every named target indexed regardless.

### Watching the queue

```bash
tools youtube queue add <target> --stages metadata,captions --watch
tools youtube queue watch 41 42 --timeout 300     # specific jobs
tools youtube queue watch --jsonl | jq .          # everything active, machine-readable
```

`queue watch` writes its event stream to stdout (that is the result); `queue add --watch`
writes progress to stderr so `--json` output stays parseable.

### MCP server

`tools youtube mcp` exposes a **curated** subset over stdio — video listing, transcript
search and windows, ask, and queue add/status. Admin, billing, cache and config verbs are
deliberately absent, and the door treats its client as untrusted:

- it reads the queue as its own console service account, never as the operator, so it
  cannot see or cancel another user's jobs;
- paging limits and retrieval depth are clamped in the handler, not merely advertised;
- `queue_add` defaults to the **free** stages (`metadata`, `captions`, `summarize`).
  Pass `transcribe` explicitly to authorise paid AI transcription of a video that has
  no captions.

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

# Transcribe

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Audio / video transcription across cloud and local providers.**

Feed `transcribe` an audio or video file, or a URL. A URL is handled by one of three drivers: YouTube (captions, then audio), X (the post's video), or a direct media file. Supports multiple providers via the shared `utils/ai` stack — pick OpenAI Whisper, Groq, Deepgram, or a local model. Shares the same audio preprocessing pipeline as `ask`.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Files and URLs** | a local file, a YouTube URL, an X/Twitter status URL, or a direct media URL |
| **Multi-provider** | OpenAI, Groq, JinaAI, local — via `AI.transcribe()` |
| **Output formats** | text, srt, vtt, json |
| **Language hints** | `--lang cs` to bias transcription |
| **Clipboard / file** | Pipe to a file or copy straight to the clipboard |

---

## Quick Start

```bash
# Plain text
tools transcribe meeting.m4a

# SRT subtitles to a file
tools transcribe interview.mp4 --format srt -o interview.srt

# Copy to clipboard
tools transcribe memo.mp3 --clipboard

# Force a specific provider + model
tools transcribe call.wav --provider openai --model whisper-1

# Hint the language
tools transcribe recording.m4a --lang cs

# YouTube (captions first, same pipeline as `tools youtube transcribe`)
tools transcribe https://youtu.be/dQw4w9WgXcQ

# X / Twitter post
tools transcribe https://x.com/poteto/status/2102050467505430555 --provider deepgram

# A file URL (mp4, mp3, webm, m3u8, ...)
tools transcribe https://cdn.example.com/talk.mp4 --provider openai
```

---

## Options

| Option | Description |
|--------|-------------|
| `<file>` | Local audio/video file, or a YouTube, X, or direct media URL |
| `--provider <name>` | Explicit provider (openai, groq, jinaai, ...) |
| `--local` | Prefer a local transcription backend |
| `--format <fmt>` | Output format: `text` (default), `srt`, `vtt`, `json` |
| `--lang <code>` | Language hint (e.g. `en`, `cs`, `de`) |
| `--model <id>` | Override provider model |
| `-o, --output <file>` | Write result to a file |
| `--clipboard` | Copy result to the clipboard |

---

## Notes

- Files are validated with the same pipeline as `ask` (via `AudioProcessor`) — unsupported formats fail fast.
- SRT / VTT output uses the shared `transcription-format` helpers so timestamps match the `ask` audio workflow.
- YouTube URLs use the caption-then-audio pipeline from `tools youtube transcribe`. `--force-transcribe` skips captions. `--no-cache` stays on the youtube command.
- An X status URL is resolved through Twitter's public syndication JSON. The lowest-bitrate MP4 is downloaded and the audio is extracted. A profile URL is not a video.
- The direct driver accepts a URL that is already the media (by extension, or by `Content-Type`). An ordinary HTML page is rejected. There is no general page scraper.
- `--price-only` reads the duration (X post JSON, YouTube metadata, or the file header) and prints a list price for each speech model. The rates live in `src/utils/ai/catalog/speech.ts`. It does not download the media. `--model nova-2-finance` inherits nova-2's price. A real transcribe keeps the converted audio for 1 hour.
